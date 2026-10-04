// API privada de la fábrica (tu panel). Todo filtrado por el dueño.

import { Hono } from "hono";
import { record } from "../audit";
import { requireUser } from "../auth";
import { all, dumps, loads, nowIso, one, run } from "../db";
import type { AppEnv } from "../env";
import { fail } from "../http";
import { hit } from "../ratelimit";
import { FX_AGENTS, fxEmit, fxSettings, fxTokensToday, ideate, STAGES } from "./engine";
import { NICHES } from "./render";
import { ensureFactorySchema } from "./schema";

export const factoryRoutes = new Hono<AppEnv>();
factoryRoutes.use("*", requireUser);
factoryRoutes.use("*", async (c, next) => { await ensureFactorySchema(c.env.DB); await next(); });
const limit = async (c: any) => { const w = await hit(c.env.DB, `fx:${c.get("user").id}`, 40, 60); if (w) fail(429, `Demasiadas acciones. Espera ${w}s.`); };
const int = (v: unknown, min: number, max: number, def: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def; };

/** Interpreta órdenes como «Crea proyectos nuevos de meme coins». */
export function parseCommand(text: string): { niche: string; count: number } {
  const t = text.toLowerCase();
  const niche = /meme|crypto|cripto|token|coin|defi|wallet|solana|ethereum|bitcoin/.test(t) ? "crypto"
    : /nutri|dieta|comida|receta|calor|macro/.test(t) ? "nutrition"
    : /deporte|sport|gym|fitness|entren|correr|running|fuerza/.test(t) ? "sport"
    : /\bia\b|\bai\b|inteligencia|agente|llm|gpt|prompt|saas|automatiz/.test(t) ? "ai" : "other";
  const n = t.match(/\b(\d{1,2})\b/);
  return { niche, count: Math.max(1, Math.min(10, n ? Number(n[1]) : 3)) };
}

factoryRoutes.get("/", async (c) => {
  const u = c.get("user");
  const db = c.env.DB;
  const s = await fxSettings(c.env, u.id);
  const projects = await all<any>(db, `SELECT id, slug, name, niche, idea, stage, status, priority, attempts, apis_json, stack, url, repo, version, errors, created_at, updated_at, live_at, last_audit_at,
    json_extract(research_json, '$.score') AS score, json_extract(spec_json, '$.tagline') AS tagline, json_extract(spec_json, '$.brand.accent') AS accent, json_extract(spec_json, '$.brand.bg') AS bg
    FROM fx_projects WHERE user_id = ? ORDER BY CASE WHEN status = 'working' THEN 0 ELSE 1 END, updated_at DESC LIMIT 300`, u.id);
  const since = new Date(Date.now() - 3 * 60_000).toISOString();
  const recent = await all<any>(db, "SELECT agent, COUNT(*) AS n, MAX(created_at) AS at FROM fx_events WHERE user_id = ? AND created_at >= ? GROUP BY agent", u.id, since);
  const working = projects.filter((p) => p.status === "working");
  const agents = FX_AGENTS.map((a) => {
    const busy = working.filter((p) => p.stage === a.stage);
    const r = recent.find((x) => x.agent === a.id);
    return { ...a, active: busy.length > 0 && (!!r || a.stage === "building" || a.stage === "testing"), recent: r?.n ?? 0, projects: busy.map((p) => p.name).slice(0, 3) };
  });
  const today = new Date().toISOString().slice(0, 10);
  const events = await all<any>(db, "SELECT e.id, e.project_id, e.stage, e.agent, e.kind, e.message, e.created_at, p.name AS project FROM fx_events e LEFT JOIN fx_projects p ON p.id = e.project_id WHERE e.user_id = ? ORDER BY e.id DESC LIMIT 80", u.id);
  return c.json({
    settings: { ...s, niches_json: undefined },
    stages: STAGES,
    niches: NICHES,
    agents,
    projects: projects.map((p) => ({ ...p, apis: loads(p.apis_json, []), apis_json: undefined })),
    counts: Object.fromEntries(STAGES.map((st) => [st, projects.filter((p) => p.stage === st && !["rejected", "failed"].includes(p.status)).length])),
    totals: {
      live: projects.filter((p) => p.stage === "live" || p.stage === "maintenance").length,
      today: projects.filter((p) => String(p.created_at) >= today).length,
      live_today: projects.filter((p) => String(p.live_at ?? "") >= today).length,
      failed: projects.filter((p) => p.status === "failed").length,
      rejected: projects.filter((p) => p.status === "rejected").length,
      tokens_today: await fxTokensToday(c.env, u.id),
    },
    events,
    approvals: [
      { id: "claude", title: "Créditos de Claude (API)", detail: "Para producir al ritmo objetivo con calidad premium. Sin ellos se usan los modelos gratuitos de Cloudflare (10.000 neuronas/día).", done: false },
      { id: "domains", title: "Dominios propios", detail: "Comprar dominios es un gasto: la fábrica nunca los compra sola. Hoy cada web vive en /s/<nombre>/.", done: false },
      { id: "workers-paid", title: "Cloudflare Workers Paid (5 $/mes)", detail: "Sube los límites de CPU, cola y Workers AI para el volumen de decenas de webs al día.", done: false },
    ],
  });
});

factoryRoutes.get("/projects/:id", async (c) => {
  const p = await one<any>(c.env.DB, "SELECT * FROM fx_projects WHERE id = ? AND user_id = ?", Number(c.req.param("id")), c.get("user").id);
  if (!p) fail(404, "Ese proyecto no existe.");
  const events = await all<any>(c.env.DB, "SELECT stage, agent, kind, message, created_at FROM fx_events WHERE project_id = ? ORDER BY id DESC LIMIT 60", p.id);
  return c.json({ ...p, html: undefined, prev_html: undefined, html_kb: p.html ? Math.round(p.html.length / 1024) : 0, research: loads(p.research_json, {}), spec: loads(p.spec_json, {}), checks: loads(p.checks_json, {}), apis: loads(p.apis_json, []), events, research_json: undefined, spec_json: undefined, checks_json: undefined, apis_json: undefined });
});

factoryRoutes.put("/settings", async (c) => {
  await limit(c);
  const u = c.get("user");
  const b = await c.req.json<any>().catch(() => ({}));
  const s = await fxSettings(c.env, u.id);
  let niches = s.niches;
  if (Array.isArray(b.niches)) niches = b.niches.filter((n: any) => NICHES.includes(n?.id)).map((n: any) => ({ id: n.id, weight: int(n.weight, 0, 10, 1), enabled: !!n.enabled }));
  let gh = s.github_connector_id;
  if (b.github_connector_id !== undefined) {
    gh = b.github_connector_id ? (await one<any>(c.env.DB, "SELECT id FROM connectors WHERE id = ? AND owner_id = ? AND type = 'github'", Number(b.github_connector_id), u.id))?.id ?? null : null;
  }
  await run(c.env.DB, "UPDATE fx_settings SET daily_target = ?, max_parallel = ?, token_budget_day = ?, auto_ideas = ?, niches_json = ?, github_connector_id = ?, theme = ?, updated_at = ? WHERE user_id = ?",
    int(b.daily_target, 1, 50, s.daily_target), int(b.max_parallel, 1, 6, s.max_parallel), int(b.token_budget_day, 20000, 5_000_000, s.token_budget_day),
    b.auto_ideas === undefined ? (s.auto_ideas ? 1 : 0) : b.auto_ideas ? 1 : 0, dumps(niches), gh, ["cobalt", "emerald", "crimson", "graphite", "violet"].includes(b.theme) ? b.theme : s.theme, nowIso(), u.id);
  return c.json({ ok: true });
});

factoryRoutes.post("/:action{start|pause}", async (c) => {
  await limit(c);
  const u = c.get("user");
  await fxSettings(c.env, u.id);
  const on = c.req.param("action") === "start";
  await run(c.env.DB, "UPDATE fx_settings SET enabled = ?, updated_at = ? WHERE user_id = ?", on ? 1 : 0, nowIso(), u.id);
  if (on) {
    await run(c.env.DB, "UPDATE fx_projects SET status = 'queued' WHERE user_id = ? AND status = 'paused'", u.id);
    const q = await all<any>(c.env.DB, "SELECT id FROM fx_projects WHERE user_id = ? AND status = 'queued' AND stage != 'live' ORDER BY priority DESC, id LIMIT 6", u.id);
    for (const p of q) await c.env.RUNS.send({ fxStep: p.id });
  }
  await fxEmit(c.env, u.id, null, "backlog", "devops", "decision", on ? "Fábrica en marcha." : "Fábrica en pausa.");
  await record(c.env.DB, { actor: u.email, userId: u.id, action: on ? "factory.start" : "factory.pause" });
  return c.json({ ok: true });
});

/** Orden en lenguaje natural o nicho explícito: crea ideas y arranca el ciclo completo. */
factoryRoutes.post("/command", async (c) => {
  await limit(c);
  const u = c.get("user");
  const b = await c.req.json<any>().catch(() => ({}));
  const text = String(b.text ?? "").slice(0, 300);
  const parsed = b.niche && NICHES.includes(b.niche) ? { niche: b.niche, count: int(b.count, 1, 10, 3) } : parseCommand(text);
  await run(c.env.DB, "UPDATE fx_settings SET enabled = 1, updated_at = ? WHERE user_id = ?", nowIso(), (await fxSettings(c.env, u.id)).user_id);
  const created = await ideate(c.env, u.id, parsed.niche, parsed.count, text);
  const q = await all<any>(c.env.DB, "SELECT id FROM fx_projects WHERE user_id = ? AND status = 'queued' AND stage = 'backlog' ORDER BY id DESC LIMIT ?", u.id, created);
  for (const p of q) await c.env.RUNS.send({ fxStep: p.id });
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "factory.command", detail: `${parsed.niche} × ${parsed.count}: ${text.slice(0, 100)}` });
  return c.json({ ok: true, niche: parsed.niche, created });
});

factoryRoutes.post("/projects/:id/:action{retry|rebuild|pause|delete|rollback}", async (c) => {
  await limit(c);
  const u = c.get("user");
  const p = await one<any>(c.env.DB, "SELECT * FROM fx_projects WHERE id = ? AND user_id = ?", Number(c.req.param("id")), u.id);
  if (!p) fail(404, "Ese proyecto no existe.");
  const a = c.req.param("action");
  if (a === "delete") {
    if (p.status === "working") fail(409, "Está trabajando ahora: páusalo primero.");
    await run(c.env.DB, "DELETE FROM fx_events WHERE project_id = ?", p.id);
    await run(c.env.DB, "DELETE FROM fx_projects WHERE id = ?", p.id);
  } else if (a === "pause") {
    await run(c.env.DB, "UPDATE fx_projects SET status = 'paused', updated_at = ? WHERE id = ? AND status != 'working'", nowIso(), p.id);
  } else if (a === "rollback") {
    if (!p.prev_html) fail(409, "No hay versión anterior.");
    await run(c.env.DB, "UPDATE fx_projects SET html = prev_html, prev_html = html, version = version + 1, updated_at = ? WHERE id = ?", nowIso(), p.id);
  } else {
    const stage = a === "rebuild" ? "building" : p.stage === "live" ? "maintenance" : p.stage;
    await run(c.env.DB, "UPDATE fx_projects SET stage = ?, status = 'queued', attempts = 0, errors = NULL, updated_at = ? WHERE id = ?", stage, nowIso(), p.id);
    await c.env.RUNS.send({ fxStep: p.id });
  }
  await fxEmit(c.env, u.id, a === "delete" ? null : p.id, p.stage, "devops", "decision", `Acción manual: ${a} «${p.name}».`);
  return c.json({ ok: true });
});
