// AGENT HUB — catálogo tipo tienda, ejecuciones de agentes y catálogo de fuentes.
//
//   AGENT HUB (esta API) → AGENT REGISTRY → AGENT ADAPTER (runtime) → AI ROUTER → Claude / Workers AI
//
// Sin estadísticas inventadas: «usos» es el número real de ejecuciones en D1.

import { Hono, type Context } from "hono";
import { record } from "./audit";
import { requireAdmin, requireUser } from "./auth";
import { all, dumps, loads, nowIso, one, run } from "./db";
import type { AppEnv } from "./env";
import { fail, intIn, jsonBody, objOf, reqStr, toId } from "./http";
import { getSubscription, PLAN_LIMITS, usageToday } from "./plans";
import { hit } from "./ratelimit";
import { getAgent, listAgents, validateManifest, type RegistryAgent } from "./agents/registry";
import { initialStages } from "./agents/runtime";
import { FRAMEWORKS, MODELS, VERIFIED_AT } from "./agents/sources";
import { CATEGORIES, TOOL_INFO } from "./agents/types";

export const hubRoutes = new Hono<AppEnv>();
hubRoutes.use("*", requireUser);

const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
const isMulti = (a: RegistryAgent) => a.stages.some((s) => s.kind === "agents");

function agentOut(a: RegistryAgent, uses: number, detail = false) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    category: a.category,
    category_label: CAT_LABEL[a.category],
    version: a.version,
    tier: a.tier,
    color: a.color,
    origin: a.origin,
    added: a.added,
    multi_agent: isMulti(a),
    sub_agents: a.stages.flatMap((s) => (s.kind === "agents" ? s.agents : [])),
    model: {
      prefer: a.model.prefer,
      advanced: Boolean(a.model.advanced),
      fallback: a.model.allowFallback,
      // Compatibilidad real según el manifiesto: todos pueden usar Claude vía router;
      // con modelo gratuito solo si prefieren gratis o permiten respaldo.
      claude_compatible: true,
      free_model_compatible: a.model.prefer === "free" || a.model.allowFallback,
    },
    capabilities: a.capabilities,
    tools: a.tools.map((t) => ({ id: t, ...TOOL_INFO[t] })),
    source: a.source,
    uses,
    ...(detail
      ? {
          input: a.input,
          instructions: a.instructions,
          stages: a.stages.map((s) => ({ id: s.id, label: s.label, kind: s.kind })),
          limits: a.limits ?? {},
        }
      : { input: a.input }),
  };
}

async function usesByAgent(db: D1Database): Promise<Record<string, number>> {
  const rows = await all<any>(db, "SELECT agent_id, COUNT(*) AS n FROM agent_runs GROUP BY agent_id");
  return Object.fromEntries(rows.map((r) => [r.agent_id, r.n]));
}

hubRoutes.get("/categories", async (c) => {
  const agents = await listAgents(c.env.DB);
  return c.json(CATEGORIES.map((cat) => ({ ...cat, count: agents.filter((a) => a.category === cat.id).length })));
});

hubRoutes.get("/agents", async (c) => {
  const q = (c.req.query("q") || "").trim().toLowerCase().slice(0, 100);
  const category = c.req.query("category") || "";
  const tier = c.req.query("tier") || ""; // free | pro
  const compat = c.req.query("compat") || ""; // claude | free-model
  const sort = c.req.query("sort") || "popular"; // popular | recent | name
  const uses = await usesByAgent(c.env.DB);
  let agents = await listAgents(c.env.DB);
  if (q) {
    agents = agents.filter((a) =>
      [a.name, a.description, a.id, CAT_LABEL[a.category], ...a.capabilities, a.source.label].join(" ").toLowerCase().includes(q),
    );
  }
  if (category) agents = agents.filter((a) => a.category === category);
  if (tier === "free" || tier === "pro") agents = agents.filter((a) => a.tier === tier);
  if (compat === "free-model") agents = agents.filter((a) => a.model.prefer === "free" || a.model.allowFallback);
  if (compat === "claude") agents = agents.filter((a) => a.model.prefer === "premium");
  const byName = (x: RegistryAgent, y: RegistryAgent) => x.name.localeCompare(y.name);
  if (sort === "name") agents.sort(byName);
  else if (sort === "recent") agents.sort((x, y) => y.added.localeCompare(x.added) || byName(x, y));
  else agents.sort((x, y) => (uses[y.id] ?? 0) - (uses[x.id] ?? 0) || byName(x, y));
  const sub = await getSubscription(c.env.DB, c.get("user").id);
  return c.json({ plan: sub.plan, total: agents.length, agents: agents.map((a) => agentOut(a, uses[a.id] ?? 0)) });
});

hubRoutes.get("/agents/:id", async (c) => {
  const a = await getAgent(c.env.DB, c.req.param("id"));
  if (!a) fail(404, "Agente no encontrado.");
  const uses = await one<any>(c.env.DB, "SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id = ?", a!.id);
  const out = agentOut(a!, uses?.n ?? 0, true);
  const subs = await Promise.all(out.sub_agents.map(async (id) => {
    const s = await getAgent(c.env.DB, id);
    return s ? { id: s.id, name: s.name, color: s.color } : { id, name: id, color: "azul" };
  }));
  return c.json({ ...out, sub_agents_info: subs });
});

function runOut(row: any, full = false) {
  const { stages_json, notices_json, output, ...rest } = row;
  return {
    ...rest,
    stages: loads(stages_json, []),
    notices: loads(notices_json, []),
    ...(full || row.output_kind !== "image" ? { output } : { output: "" }),
  };
}

hubRoutes.post("/agents/:id/run", async (c) => {
  const user = c.get("user");
  const agent = await getAgent(c.env.DB, c.req.param("id"));
  if (!agent) fail(404, "Agente no encontrado.");
  const a = agent!;
  const body = await jsonBody(c.req.raw);
  const sub = await getSubscription(c.env.DB, user.id);
  const limits = PLAN_LIMITS[sub.plan];
  const maxChars = Math.min(limits.maxInputChars, a.limits?.maxInputChars ?? Infinity);
  const input = reqStr(body, "input", { label: a.input.label, min: 1, max: 40_000 });
  if (input.length > maxChars) {
    fail(413, `Tu plan permite hasta ${maxChars.toLocaleString("es-ES")} caracteres por petición.${sub.plan === "free" ? " Con Pro el límite es mayor." : ""}`);
  }
  if (a.tier === "pro" && !limits.premiumAgents) fail(402, `«${a.name}» es un agente premium: requiere Control IA Pro.`);
  if (isMulti(a) && !limits.multiAgent) fail(402, "Los flujos multiagente requieren Control IA Pro.");
  const used = await usageToday(c.env.DB, user.id);
  if (used.agents >= limits.agentRunsPerDay) {
    fail(429, `Has usado las ${limits.agentRunsPerDay} ejecuciones de agentes de hoy.${sub.plan === "free" ? " Pro amplía el límite." : " Vuelve mañana."}`);
  }
  const wait = await hit(c.env.DB, `agent:${user.id}`, 6, 60);
  if (wait) fail(429, `Demasiadas ejecuciones seguidas. Espera ${wait} s.`);
  const now = nowIso();
  const id = await run(
    c.env.DB,
    "INSERT INTO agent_runs (user_id, agent_id, status, stage, stages_json, input, plan, created_at) VALUES (?, ?, 'pending', 'queued', ?, ?, ?, ?)",
    user.id,
    a.id,
    dumps(initialStages(a)),
    input,
    sub.plan,
    now,
  );
  await c.env.RUNS.send({ agentRunId: id });
  await record(c.env.DB, { actor: user.email, userId: user.id, action: "agent.run", target: a.id, detail: `Ejecución #${id}` });
  const row = await one<any>(c.env.DB, "SELECT * FROM agent_runs WHERE id = ?", id);
  return c.json(runOut(row), 201);
});

async function ownRun(c: Context<AppEnv>) {
  const row = await one<any>(c.env.DB, "SELECT * FROM agent_runs WHERE id = ? AND user_id = ?", toId(c.req.param("id")), c.get("user").id);
  if (!row) fail(404, "Ejecución no encontrada.");
  return row;
}

hubRoutes.get("/runs", async (c) => {
  const rows = await all<any>(
    c.env.DB,
    "SELECT id, agent_id, status, stage, stages_json, notices_json, output_kind, error, plan, created_at, started_at, finished_at," +
      " CASE WHEN output_kind = 'image' THEN '' ELSE substr(output, 1, 300) END AS output, substr(input, 1, 200) AS input" +
      " FROM agent_runs WHERE user_id = ? ORDER BY id DESC LIMIT 40",
    c.get("user").id,
  );
  return c.json(rows.map((r) => runOut(r)));
});

hubRoutes.get("/runs/:id", async (c) => c.json(runOut(await ownRun(c), true)));

hubRoutes.post("/runs/:id/cancel", async (c) => {
  const row = await ownRun(c);
  if (!["pending", "running"].includes(row.status)) fail(409, "Esta ejecución ya terminó.");
  await run(c.env.DB, "UPDATE agent_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('pending', 'running')", nowIso(), row.id);
  return c.json(runOut((await one<any>(c.env.DB, "SELECT * FROM agent_runs WHERE id = ?", row.id))!));
});

// --- Fuentes open source y licencias -------------------------------------------------

hubRoutes.get("/sources", async (c) => {
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  const status = c.req.query("status") || "";
  const page = Math.max(0, Number(c.req.query("page") || 0) | 0);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q) {
    where.push("repo LIKE ?");
    params.push(`%${q}%`);
  }
  if (status) {
    where.push("license_status = ?");
    params.push(status);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await all<any>(c.env.DB, `SELECT * FROM hub_sources ${w} ORDER BY checked_at IS NULL, repo LIMIT 50 OFFSET ?`, ...params, page * 50);
  const counts = await all<any>(c.env.DB, "SELECT license_status AS status, COUNT(*) AS n FROM hub_sources GROUP BY license_status");
  return c.json({
    verified_at: VERIFIED_AT,
    counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
    repos: rows,
    frameworks: FRAMEWORKS,
    models: MODELS,
  });
});

hubRoutes.post("/sources/check", requireAdmin, async (c) => {
  const body = await jsonBody(c.req.raw);
  const limit = intIn(body, "limit", "Cantidad", 1, 400, 80);
  const rows = await all<any>(
    c.env.DB,
    "SELECT repo FROM hub_sources WHERE license_status = 'pending' ORDER BY repo LIMIT ?",
    limit,
  );
  const repos = rows.map((r) => r.repo as string);
  // 8 repos por mensaje: ≤ 32 subpeticiones, dentro del límite de un Worker.
  for (let i = 0; i < repos.length; i += 8) await c.env.RUNS.send({ sourceCheck: repos.slice(i, i + 8) });
  const u = c.get("user");
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "hub.sources.check", detail: `${repos.length} repositorios en cola` });
  return c.json({ queued: repos.length });
});

// --- Agentes añadidos como manifiesto (administración) ------------------------------

hubRoutes.get("/submissions", requireAdmin, async (c) => {
  const rows = await all<any>(c.env.DB, "SELECT * FROM hub_agents ORDER BY updated_at DESC LIMIT 100");
  return c.json(rows.map((r) => ({ ...r, manifest: loads(r.manifest_json), validation: loads(r.validation_json, []), manifest_json: undefined, validation_json: undefined })));
});

hubRoutes.post("/submissions", requireAdmin, async (c) => {
  const body = await jsonBody(c.req.raw);
  const manifest = objOf(body, "manifest") as any;
  const known = new Set((await listAgents(c.env.DB)).map((a) => a.id));
  const isBuiltin = (await getAgent(c.env.DB, manifest.id))?.origin === "builtin";
  if (isBuiltin) fail(409, "Ya existe un agente integrado con ese id.");
  const { ok, checks } = validateManifest(manifest, known);
  const now = nowIso();
  const u = c.get("user");
  await run(
    c.env.DB,
    "INSERT INTO hub_agents (id, manifest_json, status, validation_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)" +
      " ON CONFLICT(id) DO UPDATE SET manifest_json = excluded.manifest_json, status = excluded.status, validation_json = excluded.validation_json, updated_at = excluded.updated_at",
    String(manifest.id ?? "").slice(0, 60) || `invalid-${Date.now()}`,
    dumps(manifest),
    ok ? "validated" : "rejected",
    dumps(checks),
    u.email,
    now,
    now,
  );
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "hub.agent.submit", target: String(manifest.id), result: ok ? "ok" : "error" });
  return c.json({ ok, status: ok ? "validated" : "rejected", checks }, ok ? 201 : 422);
});

hubRoutes.post("/submissions/:id/:action{publish|disable}", requireAdmin, async (c) => {
  const row = await one<any>(c.env.DB, "SELECT * FROM hub_agents WHERE id = ?", c.req.param("id"));
  if (!row) fail(404, "Agente no encontrado.");
  const action = c.req.param("action");
  if (action === "publish") {
    if (!["validated", "disabled"].includes(row.status)) fail(409, "Solo se publican agentes validados.");
    const known = new Set((await listAgents(c.env.DB)).map((a) => a.id));
    if (!validateManifest(loads(row.manifest_json), known).ok) fail(409, "El manifiesto ya no supera la validación.");
  }
  const status = action === "publish" ? "available" : "disabled";
  await run(c.env.DB, "UPDATE hub_agents SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), row.id);
  const u = c.get("user");
  await record(c.env.DB, { actor: u.email, userId: u.id, action: `hub.agent.${action}`, target: row.id });
  return c.json({ id: row.id, status });
});

