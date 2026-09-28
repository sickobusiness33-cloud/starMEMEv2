// Centro de notificaciones: listar, filtrar, leer, borrar y preferencias.
// Las notificaciones del navegador se muestran con la Notification API cuando
// la web está abierta y el usuario lo activa en sus preferencias.

import { Hono } from "hono";
import { requireUser } from "./auth";
import { all, nowIso, one, run } from "./db";
import type { AppEnv } from "./env";
import { fail, jsonBody, toId } from "./http";
import { CATEGORIES } from "./notify";

export const notificationRoutes = new Hono<AppEnv>();
notificationRoutes.use("*", requireUser);

notificationRoutes.get("/", async (c) => {
  const u = c.get("user");
  const cat = c.req.query("category") || "";
  const unread = c.req.query("unread") === "1";
  const where = ["user_id = ?"];
  const params: unknown[] = [u.id];
  if (cat) {
    if (!(cat in CATEGORIES)) fail(422, "Categoría no válida.");
    where.push("category = ?");
    params.push(cat);
  }
  if (unread) where.push("read_at IS NULL");
  const rows = await all(c.env.DB, `SELECT id, category, priority, title, body, link, read_at, created_at FROM notifications WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 60`, ...params);
  return c.json(rows);
});

notificationRoutes.get("/summary", async (c) => {
  const u = c.get("user");
  const rows = await all<any>(c.env.DB, "SELECT category, COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL GROUP BY category", u.id);
  const latest = await one<any>(
    c.env.DB,
    "SELECT id, category, priority, title, body, link, created_at FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY id DESC LIMIT 1",
    u.id,
  );
  return c.json({ unread: rows.reduce((a, r) => a + r.n, 0), by_category: Object.fromEntries(rows.map((r) => [r.category, r.n])), latest });
});

notificationRoutes.post("/read-all", async (c) => {
  const body = await jsonBody(c.req.raw).catch(() => ({}) as Record<string, unknown>);
  const cat = typeof body.category === "string" && body.category in CATEGORIES ? body.category : null;
  await run(
    c.env.DB,
    `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL${cat ? " AND category = ?" : ""}`,
    ...[nowIso(), c.get("user").id, ...(cat ? [cat] : [])],
  );
  return c.json({ ok: true });
});

notificationRoutes.post("/:id/read", async (c) => {
  await run(c.env.DB, "UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?", nowIso(), toId(c.req.param("id")), c.get("user").id);
  return c.json({ ok: true });
});

notificationRoutes.delete("/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM notifications WHERE id = ? AND user_id = ?", toId(c.req.param("id")), c.get("user").id);
  return c.json({ ok: true });
});

notificationRoutes.get("/prefs", async (c) => {
  const rows = await all<any>(c.env.DB, "SELECT category, in_app, browser FROM notification_prefs WHERE user_id = ?", c.get("user").id);
  return c.json(
    Object.entries(CATEGORIES).map(([id, info]) => {
      const r = rows.find((x) => x.category === id);
      return { id, ...info, in_app: r ? Boolean(r.in_app) : true, browser: r ? Boolean(r.browser) : false, locked: id === "seguridad" };
    }),
  );
});

notificationRoutes.put("/prefs", async (c) => {
  const body = await jsonBody(c.req.raw);
  const prefs = body.prefs;
  if (!Array.isArray(prefs)) fail(422, "Formato de preferencias no válido.");
  for (const p of prefs as any[]) {
    if (!p || !(p.id in CATEGORIES)) fail(422, "Categoría no válida.");
    await run(
      c.env.DB,
      "INSERT INTO notification_prefs (user_id, category, in_app, browser) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, category) DO UPDATE SET in_app = excluded.in_app, browser = excluded.browser",
      c.get("user").id,
      p.id,
      p.id === "seguridad" ? 1 : p.in_app ? 1 : 0,
      p.browser ? 1 : 0,
    );
  }
  return c.json({ ok: true });
});
