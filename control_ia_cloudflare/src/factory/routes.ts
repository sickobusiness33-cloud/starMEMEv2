// API privada de la fábrica (tu panel). Todo filtrado por el dueño.

import { Hono } from "hono";
import { record } from "../audit";
import { requireUser } from "../auth";
import { all, dumps, loads, nowIso, one, run } from "../db";
import type { AppEnv } from "../env";
import { fail } from "../http";
import { hit } from "../ratelimit";
import { AI_PINS, freeQuotaAvailable } from "../ai/router";
import { EXT_MODELS } from "../ai/models";
import { storedKey } from "../providers";
import { asPin, FX_AGENTS, fxEmit, fxSettings, fxTokensToday, missionTick, STAGES } from "./engine";
import { NICHES } from "./render";
import { ensureFactorySchema } from "./schema";

export const factoryRoutes = new Hono<AppEnv>();
factoryRoutes.use("*", requireUser);
factoryRoutes.use("*", async (c, next) => { await ensureFactorySchema(c.env.DB); await next(); });
const limit = async (c: any) => { const w = await hit(c.env.DB, `fx:${c.get("user").id}`, 40, 60); if (w) fail(429, `Demasiadas acciones. Espera ${w}s.`); };
const int = (v: unknown, min: number, max: number, def: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def; };

const NICHE_LABEL: Record<string, string> = { crypto: "crypto", ai: "IA", nutrition: "nutrición", sport: "deportes", other: "temática libre" };

/** Interpreta órdenes como «Créame una criptomoneda» o «Hazme webs de deportes» → misión diaria. */
export function parseCommand(text: string): { kind: "memecoin" | "website"; niche: string; perDay: number; title: string } {
  const t = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const niche = /meme|crypto|cripto|token|coin|defi|wallet|solana|ethereum|bitcoin|moneda/.test(t) ? "crypto"
    : /nutri|dieta|comida|receta|calor|macro/.test(t) ? "nutrition"
    : /deporte|sport|gym|fitness|entren|correr|running|fuerza|futbol|baloncesto|tenis/.test(t) ? "sport"
    : /\bia\b|\bai\b|inteligencia|agente|llm|gpt|prompt|saas|automatiz/.test(t) ? "ai" : "other";
  const coin = /cripto ?monedas?|criptos?\b|meme ?coins?|memecoins?|\btokens?\b|\bmonedas?\b|\bcoins?\b/.test(t) && !/\b(webs?|paginas?|sitios?|herramientas?|dashboards?|apps?|panel|landing|saas)\b/.test(t);
  const kind = coin ? "memecoin" : "website";
  const n = t.match(/(\d{1,3})\s*(?:\w+\s+){0,3}?(?:al|por|cada)\s+dia/) ?? t.match(/\b(\d{1,3})\b/);
  const perDay = Math.max(1, Math.min(50, n ? Number(n[1]) : kind === "memecoin" ? 10 : 5));
  return { kind, niche: kind === "memecoin" ? "crypto" : niche, perDay, title: kind === "memecoin" ? "Meme coins" : `Webs de ${NICHE_LABEL[niche]}` };
}

/** Crea una misión permanente y lanza ya la primera tanda. */
async function createMission(c: any, text: string, perDay?: number, forceKind?: string, aiPref?: unknown) {
  const u = c.get("user");
  const parsed = parseCommand(text);
  if (forceKind === "memecoin") Object.assign(parsed, { kind: "memecoin", niche: "crypto", title: `Meme coins · ${text.slice(0, 48)}` });
  const explicit = /\b\d{1,3}\b/.test(text);
  const per = perDay && !explicit ? int(perDay, 1, 50, parsed.perDay) : parsed.perDay;
  const s = await fxSettings(c.env, u.id);
  const active = (await one<any>(c.env.DB, "SELECT COUNT(*) AS n FROM fx_missions WHERE user_id = ? AND active = 1", u.id))?.n ?? 0;
  if (active >= 8) fail(409, "Tienes 8 misiones activas: para alguna antes de crear otra.");
  const ins = await c.env.DB.prepare("INSERT INTO fx_missions (user_id, title, prompt, kind, niche, per_day, active, ai_pref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)")
    .bind(u.id, parsed.title, text, parsed.kind, parsed.niche, per, asPin(aiPref), nowIso(), nowIso()).run();
  const id = Number(ins.meta.last_row_id);
  await run(c.env.DB, "UPDATE fx_settings SET enabled = 1, max_parallel = MAX(max_parallel, ?), updated_at = ? WHERE user_id = ?", Math.min(6, active + 3), nowIso(), s.user_id);
  await fxEmit(c.env, u.id, null, "backlog", "devops", "decision", `Nueva misión «${parsed.title}»: ${per} al día, todos los días, hasta que la pares.`);
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "factory.mission", detail: `${parsed.kind}/${parsed.niche} × ${per}/día: ${text.slice(0, 100)}` });
  const created = await missionTick(c.env, u.id, id);
  return { id, ...parsed, perDay: per, created };
}

factoryRoutes.get("/", async (c) => {
  const u = c.get("user");
  const db = c.env.DB;
  const s = await fxSettings(c.env, u.id);
  const projects = await all<any>(db, `SELECT id, slug, name, niche, idea, kind, mission_id, ai_pref, ${LAST_AI.replace(/p\.id/g, "fx_projects.id")} AS last_ai, json_extract(research_json, '$.ticker') AS ticker, stage, status, priority, attempts, apis_json, stack, url, repo, version, errors, created_at, updated_at, live_at, last_audit_at,
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
  const missions = await all<any>(db, `SELECT m.id, m.title, m.prompt, m.kind, m.niche, m.per_day, m.active, m.created_at, m.last_at,
    (SELECT COUNT(*) FROM fx_projects p WHERE p.mission_id = m.id AND p.created_at >= ?) AS made_today,
    (SELECT COUNT(*) FROM fx_projects p WHERE p.mission_id = m.id AND p.live_at >= ?) AS live_today,
    (SELECT COUNT(*) FROM fx_projects p WHERE p.mission_id = m.id AND p.stage IN ('live','maintenance')) AS live_total,
    (SELECT COUNT(*) FROM fx_projects p WHERE p.mission_id = m.id AND p.status = 'working') AS working
    FROM fx_missions m WHERE m.user_id = ? ORDER BY m.active DESC, m.id DESC`, today, today, u.id);
  const events = await all<any>(db, "SELECT e.id, e.project_id, e.stage, e.agent, e.kind, e.message, e.created_at, p.name AS project FROM fx_events e LEFT JOIN fx_projects p ON p.id = e.project_id WHERE e.user_id = ? ORDER BY e.id DESC LIMIT 80", u.id);
  return c.json({
    settings: { ...s, niches_json: undefined },
    missions,
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
  const p = await one<any>(c.env.DB, `SELECT *, ${LAST_AI.replace(/p\.id/g, "fx_projects.id")} AS last_ai FROM fx_projects WHERE id = ? AND user_id = ?`, Number(c.req.param("id")), c.get("user").id);
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
  if (b.ai_default !== undefined) await run(c.env.DB, "UPDATE fx_settings SET ai_default = ? WHERE user_id = ?", asPin(b.ai_default) ?? "claude", u.id);
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

/** Orden en lenguaje natural → misión diaria permanente (se repite sola cada día hasta pararla). */
factoryRoutes.post("/command", async (c) => {
  await limit(c);
  const b = await c.req.json<any>().catch(() => ({}));
  const text = String(b.text ?? "").replace(/[<>]/g, "").trim().slice(0, 300);
  if (text.length < 3) fail(400, "Escribe qué quieres que haga la fábrica.");
  return c.json({ ok: true, mission: await createMission(c, text, b.per_day, b.kind, b.ai_pref) });
});

/** Estado de cada IA para este usuario: conectada y disponible ahora (sin secretos). */
async function aiStatus(c: any) {
  const env = c.env, uid = c.get("user").id;
  const cool = async (key: string) => {
    const r = await one<any>(env.DB, "SELECT available_after, last_error FROM provider_health WHERE provider = ?", key);
    return r?.available_after && new Date(r.available_after).getTime() > Date.now() ? String(r.last_error ?? "en pausa").slice(0, 140) : null;
  };
  const [ak, ok, gk, qk] = await Promise.all(["anthropic", "openai", "gemini", "groq"].map((x) => storedKey(env, uid, x)));
  const row = async (id: string, label: string, connected: boolean, coolKey: string) => {
    let problem = connected ? await cool(coolKey) : null;
    if (connected && !problem && (id === "gemini" || id === "groq")) {
      // Disponible si al menos uno de sus modelos no está apartado (cupo gratis por modelo).
      const cools = await Promise.all(EXT_MODELS[id].map((mId) => cool(`model:${id}:${uid}:${mId}`)));
      if (cools.every(Boolean)) problem = `Todos sus modelos sin cupo ahora: ${cools[0]}`;
    }
    return { id, label, connected, available: connected && !problem, problem };
  };
  return Promise.all([
    row("claude", "Claude", Boolean(env.ANTHROPIC_API_KEY || ak), env.ANTHROPIC_API_KEY ? "claude-platform" : `byok:${uid}:claude-byok`),
    row("openai", "OpenAI", Boolean(ok), `byok:${uid}:openai-byok`),
    row("gemini", "Gemini", Boolean(gk), `byok:${uid}:gemini-byok`),
    row("groq", "Groq", Boolean(qk), `byok:${uid}:groq-byok`),
    row("cloudflare", "Cloudflare (gratis)", Boolean(env.AI), "workers-ai:daily-quota"),
  ]);
}
const LAST_AI = "(SELECT provider || ' · ' || model FROM usage_events WHERE kind = 'factory' AND agent_run_id = p.id AND ok = 1 AND agent_id != 'factory:logo' ORDER BY id DESC LIMIT 1)";

factoryRoutes.get("/ai", async (c) => c.json({ ais: await aiStatus(c), pins: AI_PINS }));

/** Cambia la IA de un proyecto. Si estaba parado o esperando, sigue ya con la nueva. */
factoryRoutes.post("/projects/:id/ai", async (c) => {
  await limit(c);
  const u = c.get("user");
  const p = await one<any>(c.env.DB, "SELECT * FROM fx_projects WHERE id = ? AND user_id = ?", Number(c.req.param("id")), u.id);
  if (!p) fail(404, "Ese proyecto no existe.");
  const b = await c.req.json<any>().catch(() => ({}));
  const pin = asPin(b.ai_pref);
  await run(c.env.DB, "UPDATE fx_projects SET ai_pref = ?, updated_at = ? WHERE id = ?", pin, nowIso(), p.id);
  if (b.resume && ["paused", "waiting", "failed"].includes(p.status) && !["live", "maintenance"].includes(p.stage)) {
    await run(c.env.DB, "UPDATE fx_projects SET status = 'queued', attempts = 0, errors = NULL, lease_until = NULL WHERE id = ?", p.id);
    await c.env.RUNS.send({ fxStep: p.id });
  }
  await fxEmit(c.env, u.id, p.id, p.stage, "devops", "decision", `IA cambiada a ${pin ?? "automático"}${b.resume ? " · continúa con ella" : ""}.`);
  return c.json({ ok: true, ai_pref: pin });
});

/** Coin Studio: solo meme coins (misiones, monedas con su arte y la actividad del taller). */
factoryRoutes.get("/coins", async (c) => {
  const u = c.get("user");
  const db = c.env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const missions = await all<any>(db, `SELECT m.id, m.title, m.prompt, m.per_day, m.active, m.created_at, m.last_at, m.ai_pref,
    (SELECT COUNT(*) FROM fx_projects p WHERE p.mission_id = m.id AND p.created_at >= ?) AS made_today,
    (SELECT COUNT(*) FROM fx_projects p WHERE p.mission_id = m.id AND p.stage IN ('live','maintenance')) AS live_total,
    (SELECT COUNT(*) FROM fx_projects p WHERE p.mission_id = m.id AND p.status = 'working') AS working
    FROM fx_missions m WHERE m.user_id = ? AND m.kind = 'memecoin' ORDER BY m.active DESC, m.id DESC`, today, u.id);
  const coins = await all<any>(db, `SELECT p.id, p.slug, p.name, p.idea, p.stage, p.status, p.url, p.version, p.mission_id, p.created_at, p.live_at, p.errors, p.ai_pref, ${LAST_AI} AS last_ai,
    json_extract(p.research_json, '$.ticker') AS ticker, json_extract(p.research_json, '$.theme') AS theme, json_extract(p.research_json, '$.quality') AS quality,
    json_extract(p.spec_json, '$.tagline') AS tagline, json_extract(p.spec_json, '$.coin.style') AS style, json_extract(p.spec_json, '$.coin.chain') AS chain,
    json_extract(p.spec_json, '$.brand.accent') AS accent, json_extract(p.spec_json, '$.brand.bg') AS bg, json_extract(p.spec_json, '$.coin.mascot') AS mascot,
    (SELECT GROUP_CONCAT(a.name) FROM fx_assets a WHERE a.project_id = p.id) AS images
    FROM fx_projects p WHERE p.user_id = ? AND p.kind = 'memecoin' ORDER BY p.id DESC LIMIT 400`, u.id);
  const events = await all<any>(db, `SELECT e.id, e.project_id, e.agent, e.kind, e.message, e.created_at, p.name AS project FROM fx_events e JOIN fx_projects p ON p.id = e.project_id
    WHERE e.user_id = ? AND p.kind = 'memecoin' ORDER BY e.id DESC LIMIT 40`, u.id);
  const s = await fxSettings(c.env, u.id);
  return c.json({
    enabled: s.enabled, ai_default: s.ai_default, missions, events, free_quota: await freeQuotaAvailable(c.env.DB), ais: await aiStatus(c),
    coins: coins.map((x) => ({ ...x, images: String(x.images ?? "").split(",").filter(Boolean) })),
    totals: { coins: coins.length, live: coins.filter((x) => x.stage === "live" || x.stage === "maintenance").length, today: coins.filter((x) => String(x.created_at) >= today).length, working: coins.filter((x) => x.status === "working").length, tokens_today: await fxTokensToday(c.env, u.id) },
  });
});

factoryRoutes.patch("/missions/:id", async (c) => {
  await limit(c);
  const u = c.get("user");
  const m = await one<any>(c.env.DB, "SELECT * FROM fx_missions WHERE id = ? AND user_id = ?", Number(c.req.param("id")), u.id);
  if (!m) fail(404, "Esa misión no existe.");
  const b = await c.req.json<any>().catch(() => ({}));
  const active = b.active === undefined ? m.active : b.active ? 1 : 0;
  const pin = b.ai_pref === undefined ? asPin(m.ai_pref) : asPin(b.ai_pref);
  await run(c.env.DB, "UPDATE fx_missions SET active = ?, per_day = ?, ai_pref = ?, updated_at = ? WHERE id = ?", active, int(b.per_day, 1, 50, m.per_day), pin, nowIso(), m.id);
  if (b.ai_pref !== undefined) {
    // Cambiar la IA de la misión también pasa el trabajo pendiente a la nueva IA (lo que ya está publicado no se toca).
    await run(c.env.DB, "UPDATE fx_projects SET ai_pref = ? WHERE mission_id = ? AND stage NOT IN ('live','maintenance')", pin, m.id);
    const stuck = await all<any>(c.env.DB, "UPDATE fx_projects SET status = 'queued', attempts = 0, errors = NULL WHERE mission_id = ? AND status IN ('waiting','failed') AND stage NOT IN ('live','maintenance') RETURNING id", m.id);
    for (const x of stuck) await c.env.RUNS.send({ fxStep: x.id });
    await fxEmit(c.env, c.get("user").id, null, "backlog", "devops", "decision", `Misión «${m.title}»: IA cambiada a ${pin ?? "automático"}.`);
  }
  if (!active && m.active) {
    // Parar: lo que estaba a medias se queda en pausa (lo publicado sigue online).
    await run(c.env.DB, "UPDATE fx_projects SET status = 'paused', updated_at = ? WHERE mission_id = ? AND stage NOT IN ('live','maintenance') AND status IN ('queued','waiting')", nowIso(), m.id);
    await fxEmit(c.env, u.id, null, "backlog", "devops", "decision", `Misión «${m.title}» parada.`);
  } else if (active && !m.active) {
    await run(c.env.DB, "UPDATE fx_settings SET enabled = 1, updated_at = ? WHERE user_id = ?", nowIso(), u.id);
    const q = await all<any>(c.env.DB, "UPDATE fx_projects SET status = 'queued' WHERE mission_id = ? AND status = 'paused' RETURNING id", m.id);
    for (const p of q) await c.env.RUNS.send({ fxStep: p.id });
    await fxEmit(c.env, u.id, null, "backlog", "devops", "decision", `Misión «${m.title}» reanudada.`);
    await missionTick(c.env, u.id, m.id);
  }
  return c.json({ ok: true });
});

factoryRoutes.delete("/missions/:id", async (c) => {
  await limit(c);
  const u = c.get("user");
  const m = await one<any>(c.env.DB, "SELECT * FROM fx_missions WHERE id = ? AND user_id = ?", Number(c.req.param("id")), u.id);
  if (!m) fail(404, "Esa misión no existe.");
  // Se borra la orden; lo ya creado se conserva en el registro.
  await run(c.env.DB, "UPDATE fx_projects SET status = 'paused' WHERE mission_id = ? AND stage NOT IN ('live','maintenance') AND status IN ('queued','waiting')", m.id);
  await run(c.env.DB, "UPDATE fx_projects SET mission_id = NULL WHERE mission_id = ?", m.id);
  await run(c.env.DB, "DELETE FROM fx_missions WHERE id = ?", m.id);
  return c.json({ ok: true });
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
    await run(c.env.DB, "DELETE FROM fx_assets WHERE project_id = ?", p.id);
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
