// Registro abierto, sesiones con cookie, CSRF y roles.
//
// - Cualquiera puede crear cuenta (ALLOW_SIGNUP). Los emails de ADMIN_EMAILS
//   son administradores; el resto, miembros.
// - La cookie es HttpOnly + SameSite=Strict + Secure; en D1 solo va su hash.
// - Toda petición que modifica datos exige la cabecera X-CSRF-Token.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { record } from "./audit";
import { hashPassword, randomToken, safeEqual, sha256, verifyPassword } from "./crypto";
import { all, nowIso, one, run } from "./db";
import type { AppEnv, User } from "./env";
import { EMAIL, fail, jsonBody, reqStr } from "./http";
import { hit, reset } from "./ratelimit";

const COOKIE = "cia_session";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at });

const clientIp = (c: Context<AppEnv>) => c.req.header("CF-Connecting-IP") || "local";

async function sessionFor(c: Context<AppEnv>): Promise<User | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const hash = await sha256(token);
  const row = await one<User & { expires_at: string }>(
    c.env.DB,
    "SELECT s.csrf_token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
    hash,
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await run(c.env.DB, "DELETE FROM sessions WHERE token_hash = ?", hash);
    return null;
  }
  return row;
}

async function startSession(c: Context<AppEnv>, userId: number): Promise<string> {
  const s = c.get("settings");
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + s.sessionHours * 3600_000).toISOString();
  await run(
    c.env.DB,
    "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    await sha256(token),
    userId,
    csrf,
    nowIso(),
    expires,
  );
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: s.cookieSecure,
    maxAge: s.sessionHours * 3600,
    path: "/",
  });
  return csrf;
}

/** Middleware: exige sesión y, en escrituras, el token CSRF. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await sessionFor(c);
  if (!user) return fail(401, "Sesión no iniciada o caducada. Vuelve a entrar.");
  if (!SAFE.has(c.req.method)) {
    const sent = c.req.header("X-CSRF-Token") || "";
    if (!user.csrf_token || !safeEqual(sent, user.csrf_token)) fail(403, "Falta o no coincide el token CSRF. Recarga la página.");
  }
  c.set("user", user);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user").role !== "admin") fail(403, "Esta acción requiere permisos de administrador.");
  await next();
};

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/status", async (c) => {
  const user = await sessionFor(c);
  return c.json({
    allow_signup: c.get("settings").allowSignup,
    user: user ? publicUser(user) : null,
    csrf_token: user?.csrf_token ?? null,
  });
});

authRoutes.post("/register", async (c) => {
  const s = c.get("settings");
  if (!s.allowSignup) fail(403, "El registro está cerrado en esta instalación.");
  const body = await jsonBody(c.req.raw);
  const email = reqStr(body, "email", { label: "email", min: 3, max: 200, pattern: EMAIL }).toLowerCase();
  const name = reqStr(body, "name", { label: "nombre", min: 1, max: 80 });
  const password = reqStr(body, "password", { label: "contraseña", min: 10, max: 200, trim: false });
  const wait = await hit(c.env.DB, `signup:${clientIp(c)}`, s.signupsPerHourPerIp, 3600);
  if (wait) fail(429, "Demasiados registros desde esta conexión. Prueba más tarde.");
  if (await one(c.env.DB, "SELECT id FROM users WHERE email = ?", email)) {
    fail(409, "Ya existe una cuenta con ese email. Inicia sesión.");
  }
  const role = s.adminEmails.includes(email) ? "admin" : "member";
  const id = await run(
    c.env.DB,
    "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
    email,
    name,
    await hashPassword(password),
    role,
    nowIso(),
  );
  const csrf = await startSession(c, id);
  await record(c.env.DB, { actor: email, userId: id, action: "auth.registro", detail: `rol=${role}` });
  const user = (await one<User>(c.env.DB, "SELECT * FROM users WHERE id = ?", id))!;
  return c.json({ user: publicUser(user), csrf_token: csrf });
});

authRoutes.post("/login", async (c) => {
  const s = c.get("settings");
  const body = await jsonBody(c.req.raw);
  const email = reqStr(body, "email", { label: "email", min: 3, max: 200, pattern: EMAIL }).toLowerCase();
  const password = reqStr(body, "password", { label: "contraseña", min: 1, max: 200, trim: false });
  const key = `login:${clientIp(c)}:${email}`;
  const wait = await hit(c.env.DB, key, s.loginAttemptsPerMinute, 60);
  if (wait) fail(429, `Demasiados intentos. Prueba de nuevo en ${wait} s.`);
  const user = await one<User>(c.env.DB, "SELECT * FROM users WHERE email = ?", email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    await record(c.env.DB, { actor: email, action: "auth.login", result: "error", detail: "Credenciales incorrectas" });
    // Mismo mensaje exista o no la cuenta, para no revelar usuarios.
    fail(401, "Email o contraseña incorrectos.");
  }
  await reset(c.env.DB, key);
  const csrf = await startSession(c, user!.id);
  await record(c.env.DB, { actor: user!.email, userId: user!.id, action: "auth.login" });
  return c.json({ user: publicUser(user!), csrf_token: csrf });
});

authRoutes.post("/logout", requireUser, async (c) => {
  const token = getCookie(c, COOKIE) || "";
  await run(c.env.DB, "DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
  deleteCookie(c, COOKIE, { path: "/" });
  const u = c.get("user");
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "auth.logout" });
  return c.json({ ok: true });
});

authRoutes.post("/password", requireUser, async (c) => {
  const body = await jsonBody(c.req.raw);
  const current = reqStr(body, "current_password", { label: "contraseña actual", min: 1, max: 200, trim: false });
  const next = reqStr(body, "new_password", { label: "nueva contraseña", min: 10, max: 200, trim: false });
  const u = c.get("user");
  if (!(await verifyPassword(current, u.password_hash))) fail(400, "La contraseña actual no es correcta.");
  await run(c.env.DB, "UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(next), u.id);
  // Cierra el resto de sesiones del usuario.
  const token = getCookie(c, COOKIE) || "";
  await run(c.env.DB, "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", u.id, await sha256(token));
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "auth.cambiar_contraseña" });
  return c.json({ ok: true });
});

authRoutes.delete("/account", requireUser, async (c) => {
  const u = c.get("user");
  if (c.req.query("confirm") !== "true") {
    fail(428, "Eliminar la cuenta borra tus proyectos, claves y conectores. Confirma la acción.");
  }
  await run(c.env.DB, "DELETE FROM users WHERE id = ?", u.id);
  deleteCookie(c, COOKIE, { path: "/" });
  await record(c.env.DB, { actor: u.email, action: "auth.eliminar_cuenta", detail: `id=${u.id}` });
  return c.json({ ok: true });
});

authRoutes.get("/users", requireUser, requireAdmin, async (c) => {
  const rows = await all<User>(c.env.DB, "SELECT * FROM users ORDER BY id DESC LIMIT 500");
  return c.json(rows.map(publicUser));
});
