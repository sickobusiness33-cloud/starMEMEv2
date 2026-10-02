// Copia de los datos de Control IA en Firestore (Firebase).
//
// D1 sigue siendo la base de datos principal de la web. Cada cambio importante
// se copia a Firestore para consultarlo desde la consola de Firebase, junto a
// otros proyectos del mismo dueño:
//   apps/control-ia/users/{uid}
//   apps/control-ia/users/{uid}/projects/{pid}      (incluye memoria)
//   apps/control-ia/users/{uid}/runs/{rid}          (plan, agentes, eventos, resultado)
//   apps/control-ia/users/{uid}/threads/{tid}       (últimos mensajes)
// Nunca se copian contraseñas, sesiones ni claves de API.
// Se activa solo si existe el secreto FIREBASE_SERVICE_ACCOUNT.

import { Hono } from "hono";
import { requireAdmin, requireUser } from "./auth";
import { redact } from "./crypto";
import { all, loads, nowIso, one } from "./db";
import type { AppEnv, Env } from "./env";

type SA = { client_email: string; private_key: string; project_id: string };
let tokenCache: { token: string; exp: number; email: string } | null = null;
let lastError: string | null = null;
let lastOk: string | null = null;

function account(env: Env): SA | null {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return null;
  try {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    return sa.client_email && sa.private_key && sa.project_id ? sa : null;
  } catch {
    return null;
  }
}

export const firebaseEnabled = (env: Env) => account(env) !== null;

/** Copia en segundo plano tras responder (no retrasa la petición). */
export function mirrorLater(c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } }, kind: "user" | "project" | "run" | "thread", id: number | null | undefined) {
  if (!id || !firebaseEnabled(c.env)) return;
  try {
    c.executionCtx.waitUntil(mirror(c.env, kind, id));
  } catch {
    /* sin contexto de ejecución (tests) */
  }
}

const b64url = (data: ArrayBuffer | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function accessToken(sa: SA): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.email === sa.client_email && tokenCache.exp - 60 > now) return tokenCache.token;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${sig}` }),
  });
  const data: any = await r.json();
  if (!r.ok || !data.access_token) throw new Error(`Google OAuth: ${data.error_description || data.error || r.status}`);
  tokenCache = { token: data.access_token, exp: now + Number(data.expires_in || 3600), email: sa.client_email };
  return data.access_token;
}

/** Valor JS → formato de Firestore REST. */
function toValue(v: unknown): any {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) ? { timestampValue: v } : { stringValue: v.slice(0, 200_000) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, toValue(x)])) } };
  return { stringValue: String(v) };
}

async function writeDoc(env: Env, path: string, data: Record<string, unknown>) {
  const sa = account(env);
  if (!sa) return;
  const token = await accessToken(sa);
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/apps/control-ia/${path}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries({ ...data, synced_at: nowIso() }).map(([k, v]) => [k, toValue(v)])) }),
  });
  if (!r.ok) {
    const err: any = await r.json().catch(() => ({}));
    throw new Error(`Firestore ${r.status}: ${err?.error?.message ?? r.statusText}`);
  }
}

async function deleteDoc(env: Env, path: string) {
  const sa = account(env);
  if (!sa) return;
  const token = await accessToken(sa);
  await fetch(`https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/apps/control-ia/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// --- qué se copia ----------------------------------------------------------------------------

async function syncUser(env: Env, id: number) {
  const u = await one<any>(env.DB, "SELECT id, email, name, role, created_at FROM users WHERE id = ?", id);
  if (!u) return deleteDoc(env, `users/${id}`);
  const sub = await one<any>(env.DB, "SELECT plan, subscription_status, renewal_date FROM subscriptions WHERE user_id = ?", id);
  await writeDoc(env, `users/${id}`, { ...u, plan: sub?.plan ?? "free", subscription_status: sub?.subscription_status ?? "none" });
}

async function syncProject(env: Env, id: number) {
  const p = await one<any>(env.DB, "SELECT id, owner_id, name, description, objective, template, instructions, color, status, created_at, updated_at FROM projects WHERE id = ?", id);
  if (!p) return;
  const memory = await all<any>(env.DB, "SELECT kind, content, pinned, source, updated_at FROM project_memory WHERE project_id = ? ORDER BY id", id);
  const stats = await one<any>(env.DB, "SELECT COUNT(*) AS runs, SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed FROM chat_runs WHERE project_id = ?", id);
  const files = await all<any>(env.DB, "SELECT name, size, include_in_context, created_at FROM project_files WHERE project_id = ? ORDER BY id", id);
  const { owner_id, ...rest } = p;
  await writeDoc(env, `users/${owner_id}/projects/${id}`, {
    ...rest,
    memory: memory.map((m) => ({ ...m, pinned: Boolean(m.pinned) })),
    files,
    stats: { runs: stats?.runs ?? 0, completed: stats?.completed ?? 0, failed: stats?.failed ?? 0 },
  });
}

async function syncRun(env: Env, id: number) {
  const r = await one<any>(env.DB, "SELECT * FROM chat_runs WHERE id = ?", id);
  if (!r) return;
  const req = await one<any>(env.DB, "SELECT content FROM chat_messages WHERE id = ?", r.message_id);
  const res = r.result_message_id ? await one<any>(env.DB, "SELECT content, provider, model FROM chat_messages WHERE id = ?", r.result_message_id) : null;
  const agents = await all<any>(env.DB, "SELECT step, agent_id, role, task, status, action, model, provider, fallback, confidence, why, execution_ms FROM chat_run_agents WHERE run_id = ? ORDER BY id", id);
  const events = await all<any>(env.DB, "SELECT ts, ms, type, step, agent_id, status, action FROM run_events WHERE run_id = ? ORDER BY id", id);
  const plan = loads<any>(r.plan_json, {});
  await writeDoc(env, `users/${r.user_id}/runs/${id}`, {
    project_id: r.project_id, thread_id: r.thread_id, status: r.status, mode: r.mode, task_type: r.task_type, planner: plan.planner ?? null, reason: plan.reason ?? null,
    request: req?.content ?? "", result: res?.content ?? null, result_model: res?.model ?? null, error: r.error,
    agents, events, notices: loads(r.notices_json, []), created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
  });
}

async function syncThread(env: Env, id: number) {
  const t = await one<any>(env.DB, "SELECT id, user_id, project_id, title, mode, created_at, updated_at FROM chat_threads WHERE id = ?", id);
  if (!t) return;
  const msgs = await all<any>(env.DB, "SELECT role, content, provider, model, agent_id, created_at FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 60", id);
  const { user_id, ...rest } = t;
  await writeDoc(env, `users/${user_id}/threads/${id}`, { ...rest, messages: msgs.reverse() });
}

const SYNC = { user: syncUser, project: syncProject, run: syncRun, thread: syncThread };

/** Copia a Firestore sin bloquear nunca la web: los errores solo se registran. */
export async function mirror(env: Env, kind: keyof typeof SYNC, id: number | null | undefined) {
  if (!id || !firebaseEnabled(env)) return;
  try {
    await SYNC[kind](env, id);
    lastOk = nowIso();
  } catch (err) {
    lastError = redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
    console.error("Firebase", kind, id, lastError);
  }
}

/** Consumidor de la cola para la copia inicial (en lotes pequeños). */
export async function processFirebaseSync(env: Env, msg: { kind: keyof typeof SYNC; ids: number[] }) {
  for (const id of msg.ids.slice(0, 10)) await mirror(env, msg.kind, id);
}

export const firebaseRoutes = new Hono<AppEnv>();
firebaseRoutes.use("*", requireUser, requireAdmin);

firebaseRoutes.get("/status", (c) => {
  const sa = account(c.env);
  return c.json({ configured: Boolean(sa), project_id: sa?.project_id ?? null, client_email: sa?.client_email ?? null, last_ok: lastOk, last_error: lastError, path: "apps/control-ia/users/{uid}/…" });
});

/** Prueba real: escribe un documento de control y devuelve el resultado. */
firebaseRoutes.post("/test", async (c) => {
  if (!firebaseEnabled(c.env)) return c.json({ ok: false, error: "Falta el secreto FIREBASE_SERVICE_ACCOUNT (o su JSON no es válido)." }, 400);
  try {
    await writeDoc(c.env, "status/health", { ok: true, by: c.get("user").email });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: redact(err instanceof Error ? err.message : String(err)) }, 502);
  }
});

/** Copia inicial de todo lo existente (en lotes por la cola). */
firebaseRoutes.post("/sync-all", async (c) => {
  if (!firebaseEnabled(c.env)) return c.json({ ok: false, error: "Falta el secreto FIREBASE_SERVICE_ACCOUNT." }, 400);
  const lists: [keyof typeof SYNC, string][] = [["user", "SELECT id FROM users"], ["project", "SELECT id FROM projects"], ["thread", "SELECT id FROM chat_threads"], ["run", "SELECT id FROM chat_runs"]];
  let total = 0;
  for (const [kind, sql] of lists) {
    const ids = (await all<any>(c.env.DB, sql)).map((r) => r.id);
    total += ids.length;
    for (let i = 0; i < ids.length; i += 10) await c.env.RUNS.send({ firebaseSync: { kind, ids: ids.slice(i, i + 10) } });
  }
  return c.json({ ok: true, queued: total });
});
