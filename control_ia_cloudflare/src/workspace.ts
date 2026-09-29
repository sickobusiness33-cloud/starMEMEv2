// AI AGENT OS — espacio de trabajo de cada proyecto, centro de comandos global,
// memoria del proyecto, eventos de ejecución y preferencias de interfaz.
//
// Todos los datos salen de tablas reales (chat_runs, chat_run_agents,
// run_events, project_memory…). Nada se inventa: si no hay datos, se devuelve vacío.

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { record } from "./audit";
import { requireUser } from "./auth";
import { ACTIVE, createThread, startOrchestrated } from "./chat";
import { all, dumps, loads, nowIso, one, run } from "./db";
import type { AppEnv } from "./env";
import { fail, jsonBody, reqStr, str, toId } from "./http";
import { ownedImages } from "./hub";
import { getSubscription, PLAN_LIMITS, usageToday } from "./plans";
import { hit } from "./ratelimit";
import { MODELS } from "./ai/models";
import { listAgents } from "./agents/registry";
import { CATEGORIES } from "./agents/types";
import { runState } from "./orchestrator/executor";
import { orchestratorPool, roleOf } from "./orchestrator/planner";
import { TEMPLATES, TEMPLATE_MAP } from "./templates";

export const workspaceRoutes = new Hono<AppEnv>();
workspaceRoutes.use("*", requireUser);

const IN_ACTIVE = `(${ACTIVE.map((s) => `'${s}'`).join(",")})`;
const MEMORY_KINDS = ["objective", "instruction", "preference", "decision", "fact"];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));

async function ownProject(c: Context<AppEnv>, raw?: string) {
  const p = await one<any>(c.env.DB, "SELECT * FROM projects WHERE id = ? AND owner_id = ?", toId(raw ?? c.req.param("id")), c.get("user").id);
  if (!p) fail(404, "Proyecto no encontrado.");
  return p;
}

workspaceRoutes.get("/templates", (c) => c.json(TEMPLATES.map(({ memory, instructions, ...t }) => ({ ...t, memory_count: memory.length, has_instructions: Boolean(instructions) }))));

// --- Resumen del proyecto (Overview + Mission Control) ---------------------------------------

workspaceRoutes.get("/projects/:id", async (c) => {
  const p = await ownProject(c);
  const db = c.env.DB;
  const stats = await one<any>(
    db,
    `SELECT COUNT(*) AS runs, SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed, SUM(status IN ${IN_ACTIVE}) AS active,
       CAST(AVG(CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL THEN (julianday(finished_at) - julianday(started_at)) * 86400000 END) AS INTEGER) AS avg_ms
     FROM chat_runs WHERE project_id = ?`,
    p.id,
  );
  const agentStats = await one<any>(
    db,
    "SELECT COUNT(*) AS tasks, SUM(a.status = 'COMPLETED') AS done, COUNT(DISTINCT a.agent_id) AS agents FROM chat_run_agents a JOIN chat_runs r ON r.id = a.run_id WHERE r.project_id = ?",
    p.id,
  );
  const latest = await one<any>(db, "SELECT id FROM chat_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1", p.id);
  const lastResult = await one<any>(
    db,
    "SELECT m.content, m.created_at, r.id AS run_id FROM chat_runs r JOIN chat_messages m ON m.id = r.result_message_id WHERE r.project_id = ? AND r.status = 'completed' ORDER BY r.id DESC LIMIT 1",
    p.id,
  );
  const threads = await all<any>(db, "SELECT id, title, updated_at FROM chat_threads WHERE project_id = ? ORDER BY updated_at DESC LIMIT 20", p.id);
  const memory = await all<any>(db, "SELECT * FROM project_memory WHERE project_id = ? ORDER BY id", p.id);
  const files = await one<any>(db, "SELECT COUNT(*) AS n FROM project_files WHERE project_id = ?", p.id);
  const events = await all<any>(
    db,
    "SELECT e.id, e.run_id, e.ts, e.type, e.step, e.agent_id, e.status, e.action FROM run_events e JOIN chat_runs r ON r.id = e.run_id WHERE r.project_id = ? ORDER BY e.id DESC LIMIT 12",
    p.id,
  );
  return c.json({
    project: {
      id: p.id, name: p.name, objective: p.objective || p.description, description: p.description, template: p.template, color: p.color, status: p.status,
      instructions: p.instructions, provider: p.provider || "auto", model: p.model || "auto", created_at: p.created_at, updated_at: p.updated_at,
    },
    stats: {
      runs: stats?.runs ?? 0, completed: stats?.completed ?? 0, failed: stats?.failed ?? 0, active: stats?.active ?? 0, avg_ms: stats?.avg_ms ?? null,
      tasks: agentStats?.tasks ?? 0, tasks_done: agentStats?.done ?? 0, agents_used: agentStats?.agents ?? 0, files: files?.n ?? 0,
    },
    latest: latest ? await runState(db, latest.id) : null,
    last_result: lastResult,
    threads,
    memory,
    events: events.reverse(),
  });
});

// --- Tareas (historial de ejecuciones) -----------------------------------------------------------

workspaceRoutes.get("/projects/:id/runs", async (c) => {
  const p = await ownProject(c);
  const runs = await all<any>(
    c.env.DB,
    `SELECT r.id, r.status, r.mode, r.task_type, r.created_at, r.started_at, r.finished_at, r.error, r.thread_id, m.content AS request
     FROM chat_runs r JOIN chat_messages m ON m.id = r.message_id WHERE r.project_id = ? ORDER BY r.id DESC LIMIT 50`,
    p.id,
  );
  const ids = runs.map((r) => r.id);
  const agents = ids.length
    ? await all<any>(c.env.DB, `SELECT run_id, agent_id, role, status FROM chat_run_agents WHERE run_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ...ids)
    : [];
  return c.json(runs.map((r) => ({ ...r, request: String(r.request).slice(0, 200), agents: agents.filter((a) => a.run_id === r.id) })));
});

/** Ejecución completa + todos sus eventos (Task Graph, detalle y REPLAY). */
workspaceRoutes.get("/runs/:id", async (c) => {
  const r = await one<any>(c.env.DB, "SELECT id FROM chat_runs WHERE id = ? AND user_id = ?", toId(c.req.param("id")), c.get("user").id);
  if (!r) fail(404, "Ejecución no encontrada.");
  const state = await runState(c.env.DB, r.id);
  const events = await all<any>(c.env.DB, "SELECT id, ts, ms, type, step, agent_id, status, action, progress, data_json FROM run_events WHERE run_id = ? ORDER BY id", r.id);
  return c.json({ ...state, events: events.map(({ data_json, ...e }) => ({ ...e, data: loads(data_json, {}) })) });
});

// --- Actividad del proyecto ----------------------------------------------------------------------

workspaceRoutes.get("/projects/:id/activity", async (c) => {
  const p = await ownProject(c);
  const before = Number(c.req.query("before") || 0) || Number.MAX_SAFE_INTEGER;
  const rows = await all<any>(
    c.env.DB,
    "SELECT e.id, e.run_id, e.ts, e.ms, e.type, e.step, e.agent_id, e.status, e.action, e.progress FROM run_events e JOIN chat_runs r ON r.id = e.run_id WHERE r.project_id = ? AND e.id < ? ORDER BY e.id DESC LIMIT 80",
    p.id,
    before,
  );
  return c.json(rows);
});

// --- Agentes del proyecto (biblioteca) -----------------------------------------------------------

workspaceRoutes.get("/projects/:id/agents", async (c) => {
  const p = await ownProject(c);
  const sub = await getSubscription(c.env.DB, c.get("user").id);
  const pool = orchestratorPool(await listAgents(c.env.DB), sub.plan);
  const usage = await all<any>(
    c.env.DB,
    `SELECT a.agent_id, COUNT(*) AS tasks, SUM(a.status = 'COMPLETED') AS done, SUM(a.status = 'ERROR') AS errors,
       SUM(a.status NOT IN ('COMPLETED', 'ERROR') AND r.status IN ${IN_ACTIVE}) AS active, CAST(AVG(a.execution_ms) AS INTEGER) AS avg_ms, MAX(r.created_at) AS last_used
     FROM chat_run_agents a JOIN chat_runs r ON r.id = a.run_id WHERE r.project_id = ? GROUP BY a.agent_id`,
    p.id,
  );
  const u = new Map(usage.map((x) => [x.agent_id, x]));
  return c.json({
    agents: pool.map((a) => ({
      id: a.id, name: a.name, description: a.description, category: a.category, category_label: CAT_LABEL[a.category], color: a.color,
      role: roleOf(a), tier: a.tier, locked: a.locked, tools: a.tools, capabilities: a.capabilities,
      usage: u.get(a.id) ?? { tasks: 0, done: 0, errors: 0, active: 0, avg_ms: null, last_used: null },
    })),
    reviewer: u.get("kairo-reviewer") ?? null,
  });
});

// --- Analíticas ----------------------------------------------------------------------------------------

workspaceRoutes.get("/projects/:id/analytics", async (c) => {
  const p = await ownProject(c);
  const db = c.env.DB;
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const perDay = await all<any>(db, "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS runs, SUM(status = 'completed') AS ok FROM chat_runs WHERE project_id = ? AND created_at >= ? GROUP BY day ORDER BY day", p.id, since);
  const byAgent = await all<any>(
    db,
    "SELECT a.agent_id, a.role, COUNT(*) AS tasks, CAST(AVG(a.execution_ms) AS INTEGER) AS avg_ms, SUM(a.fallback) AS fallbacks FROM chat_run_agents a JOIN chat_runs r ON r.id = a.run_id WHERE r.project_id = ? GROUP BY a.agent_id ORDER BY tasks DESC LIMIT 12",
    p.id,
  );
  const byModel = await all<any>(
    db,
    "SELECT a.model, COUNT(*) AS tasks FROM chat_run_agents a JOIN chat_runs r ON r.id = a.run_id WHERE r.project_id = ? AND a.model IS NOT NULL GROUP BY a.model ORDER BY tasks DESC LIMIT 10",
    p.id,
  );
  const byType = await all<any>(db, "SELECT COALESCE(task_type, 'general') AS type, COUNT(*) AS runs FROM chat_runs WHERE project_id = ? GROUP BY type ORDER BY runs DESC", p.id);
  return c.json({ per_day: perDay, by_agent: byAgent, by_model: byModel, by_type: byType });
});

// --- Memoria del proyecto -----------------------------------------------------------------------------

workspaceRoutes.get("/projects/:id/memory", async (c) => {
  const p = await ownProject(c);
  return c.json(await all(c.env.DB, "SELECT * FROM project_memory WHERE project_id = ? ORDER BY id", p.id));
});

workspaceRoutes.post("/projects/:id/memory", async (c) => {
  const p = await ownProject(c);
  const body = await jsonBody(c.req.raw);
  const kind = reqStr(body, "kind", { label: "Tipo", min: 3, max: 20 });
  if (!MEMORY_KINDS.includes(kind)) fail(422, "Tipo de memoria no válido.");
  const content = reqStr(body, "content", { label: "Contenido", min: 2, max: 1000 });
  const count = await one<any>(c.env.DB, "SELECT COUNT(*) AS n FROM project_memory WHERE project_id = ?", p.id);
  if ((count?.n ?? 0) >= 100) fail(422, "Máximo 100 entradas de memoria por proyecto.");
  const now = nowIso();
  const id = await run(
    c.env.DB,
    "INSERT INTO project_memory (project_id, kind, content, pinned, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    p.id, kind, content, body.pinned === false ? 0 : 1, body.source === "kairo" ? "kairo" : "user", now, now,
  );
  await record(c.env.DB, { actor: c.get("user").email, userId: c.get("user").id, projectId: p.id, action: "proyecto.memoria.crear", target: kind });
  return c.json(await one(c.env.DB, "SELECT * FROM project_memory WHERE id = ?", id), 201);
});

async function ownMemory(c: Context<AppEnv>) {
  const m = await one<any>(
    c.env.DB,
    "SELECT m.* FROM project_memory m JOIN projects p ON p.id = m.project_id WHERE m.id = ? AND p.owner_id = ?",
    toId(c.req.param("mid")),
    c.get("user").id,
  );
  if (!m) fail(404, "Entrada de memoria no encontrada.");
  return m;
}

workspaceRoutes.patch("/memory/:mid", async (c) => {
  const m = await ownMemory(c);
  const body = await jsonBody(c.req.raw);
  const content = str(body, "content", { label: "Contenido", min: 2, max: 1000, optional: true }) ?? m.content;
  const kind = str(body, "kind", { label: "Tipo", max: 20, optional: true }) ?? m.kind;
  if (!MEMORY_KINDS.includes(kind)) fail(422, "Tipo de memoria no válido.");
  const pinned = body.pinned === undefined ? m.pinned : body.pinned ? 1 : 0;
  await run(c.env.DB, "UPDATE project_memory SET content = ?, kind = ?, pinned = ?, updated_at = ? WHERE id = ?", content, kind, pinned, nowIso(), m.id);
  return c.json(await one(c.env.DB, "SELECT * FROM project_memory WHERE id = ?", m.id));
});

workspaceRoutes.delete("/memory/:mid", async (c) => {
  const m = await ownMemory(c);
  await run(c.env.DB, "DELETE FROM project_memory WHERE id = ?", m.id);
  return c.json({ ok: true });
});

// --- Tiempo real del proyecto (Mission Control / red de agentes) --------------------------------------

/**
 * SSE del proyecto: sigue la ejecución más reciente del proyecto. Comprueba
 * cada 500 ms (una lectura ligera) y solo envía cuando cambia la versión o
 * empieza una ejecución nueva. Tras 3 minutos cierra; el navegador reconecta.
 */
workspaceRoutes.get("/projects/:id/stream", async (c) => {
  const p = await ownProject(c);
  const db = c.env.DB;
  return streamSSE(c, async (stream) => {
    let key = "";
    const t0 = Date.now();
    while (!stream.aborted && Date.now() - t0 < 180_000) {
      const r = await one<any>(db, "SELECT id, version, status FROM chat_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1", p.id);
      const k = r ? `${r.id}:${r.version}` : "none";
      if (k !== key) {
        key = k;
        await stream.writeSSE({ event: "state", data: JSON.stringify(r ? await runState(db, r.id) : null), id: k });
      }
      await stream.sleep(r && ACTIVE.includes(r.status) ? 500 : 1500);
    }
  });
});

// --- Dashboard principal -------------------------------------------------------------------------------

workspaceRoutes.get("/home", async (c) => {
  const u = c.get("user");
  const db = c.env.DB;
  const sub = await getSubscription(db, u.id);
  const projects = await all<any>(
    db,
    `SELECT p.id, p.name, p.objective, p.description, p.color, p.template, p.updated_at,
       (SELECT COUNT(*) FROM chat_runs r WHERE r.project_id = p.id) AS runs,
       (SELECT COUNT(*) FROM chat_runs r WHERE r.project_id = p.id AND r.status IN ${IN_ACTIVE}) AS active
     FROM projects p WHERE p.owner_id = ? AND p.status = 'active' ORDER BY p.updated_at DESC LIMIT 8`,
    u.id,
  );
  const live = await all<any>(db, `SELECT id FROM chat_runs WHERE user_id = ? AND status IN ${IN_ACTIVE} ORDER BY id DESC LIMIT 4`, u.id);
  const recentRuns = await all<any>(
    db,
    `SELECT r.id, r.status, r.task_type, r.project_id, r.thread_id, r.created_at, r.finished_at, m.content AS request, p.name AS project_name
     FROM chat_runs r JOIN chat_messages m ON m.id = r.message_id LEFT JOIN projects p ON p.id = r.project_id WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 10`,
    u.id,
  );
  const events = await all<any>(
    db,
    "SELECT e.id, e.run_id, e.ts, e.type, e.agent_id, e.status, e.action, r.project_id FROM run_events e JOIN chat_runs r ON r.id = e.run_id WHERE r.user_id = ? ORDER BY e.id DESC LIMIT 14",
    u.id,
  );
  const tasks = await one<any>(
    db,
    `SELECT COUNT(*) AS total, SUM(r.status = 'completed') AS completed, SUM(r.status = 'failed') AS failed, SUM(r.status IN ${IN_ACTIVE}) AS active FROM chat_runs r WHERE r.user_id = ?`,
    u.id,
  );
  const agentsUsed = await all<any>(
    db,
    "SELECT a.agent_id, a.role, COUNT(*) AS n FROM chat_run_agents a JOIN chat_runs r ON r.id = a.run_id WHERE r.user_id = ? GROUP BY a.agent_id ORDER BY n DESC LIMIT 8",
    u.id,
  );
  const health = await all<any>(db, "SELECT provider, available_after FROM provider_health WHERE available_after IS NOT NULL");
  const cooling = new Set(health.filter((h) => new Date(h.available_after).getTime() > Date.now()).map((h) => h.provider));
  const images = await all<any>(db, "SELECT id, prompt, model, created_at FROM images WHERE user_id = ? AND mode <> 'upload' ORDER BY id DESC LIMIT 6", u.id);
  const pool = orchestratorPool(await listAgents(db), sub.plan);
  return c.json({
    plan: sub.plan,
    limits: PLAN_LIMITS[sub.plan],
    usage_today: await usageToday(db, u.id),
    projects,
    live: await Promise.all(live.map((r) => runState(db, r.id))),
    recent_runs: recentRuns.map((r) => ({ ...r, request: String(r.request).slice(0, 160) })),
    events: events.reverse(),
    tasks: { total: tasks?.total ?? 0, completed: tasks?.completed ?? 0, failed: tasks?.failed ?? 0, active: tasks?.active ?? 0 },
    agents: { available: pool.filter((a) => !a.locked).length, locked: pool.filter((a) => a.locked).length, most_used: agentsUsed },
    models: MODELS.map((m) => ({ id: m.id, label: m.label, kind: m.kind, source: m.source, status: cooling.has(`model:${m.id}`) || (m.adapter === "anthropic" && cooling.has("claude-platform")) ? "cooldown" : "ready" })),
    images,
  });
});

// --- Centro de comandos global ------------------------------------------------------------------------

const STOP = new Set("que los las del por una uno sus the and para como con una unos unas este esta estos estas quiero hacer crear sobre desde entre todo toda todos cual cuál donde dónde cuando cuándo porque tiene tener puedes puede sería ayuda ayudame ayúdame necesito dame favor mucho muy más menos también".split(" "));

function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

const LONG_TERM = /\b(proyecto|crear|construir|desarrollar|lanzar|montar|disenar|diseñar|empezar)\b[\s\S]{0,60}\b(web|app|aplicaci|tienda|marca|campa|negocio|landing|plataforma|blog|canal|startup|producto|juego)/i;

/** Analiza una petición: ¿proyecto existente, proyecto nuevo o tarea independiente? */
workspaceRoutes.post("/command/analyze", async (c) => {
  const body = await jsonBody(c.req.raw);
  const text = reqStr(body, "text", { label: "Petición", min: 2, max: 4000 });
  const projects = await all<any>(c.env.DB, "SELECT id, name, objective, description FROM projects WHERE owner_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 100", c.get("user").id);
  const want = tokens(text);
  let best: { p: any; score: number; hits: string[] } | null = null;
  for (const p of projects) {
    const inName = tokens(p.name);
    const have = tokens(`${p.name} ${p.objective} ${p.description}`);
    const hits = [...want].filter((w) => have.has(w));
    // Las palabras del nombre pesan el doble; nombrar el proyecto entero asegura la coincidencia.
    const nameHit = text.toLowerCase().includes(String(p.name).toLowerCase()) ? 3 : 0;
    const score = hits.length + hits.filter((w) => inName.has(w)).length + nameHit;
    if (score > (best?.score ?? 0)) best = { p, score, hits };
  }
  if (best && best.score >= 2) {
    return c.json({ suggestion: "project", project: { id: best.p.id, name: best.p.name }, reason: `Coincide con «${best.p.name}» (${best.hits.slice(0, 4).join(", ") || "nombre"}).` });
  }
  if (LONG_TERM.test(text)) {
    // Nombre sugerido: el objeto de la frase («crear una tienda online de camisetas» → «Tienda online de camisetas»).
    const m = /\b(?:crear|construir|desarrollar|lanzar|montar|dise[nñ]ar|empezar)\s+(?:(?:un|una|el|la|mi|nuestro|nuestra)\s+)?(.+)$/i.exec(text.replace(/\s+/g, " ").trim());
    const name = (m ? m[1] : text).split(" ").slice(0, 6).join(" ").replace(/[.,;:!?]+$/, "");
    const tpl = /\b(web|app|landing|codigo|código|api|software)\b/i.test(text) ? "software" : /\b(campa|marketing|anuncio|redes)\b/i.test(text) ? "marketing" : /\b(negocio|startup|tienda)\b/i.test(text) ? "business" : "custom";
    return c.json({ suggestion: "new", new_name: name.charAt(0).toUpperCase() + name.slice(1), template: tpl, reason: "Parece un objetivo de largo plazo: conviene un proyecto con memoria propia." });
  }
  return c.json({ suggestion: "standalone", reason: "Tarea puntual: se ejecuta sin proyecto." });
});

workspaceRoutes.post("/command/run", async (c) => {
  const user = c.get("user");
  const body = await jsonBody(c.req.raw);
  const text = reqStr(body, "text", { label: "Petición", min: 2, max: 40_000 });
  const sub = await getSubscription(c.env.DB, user.id);
  const limits = PLAN_LIMITS[sub.plan];
  if (text.length > limits.maxInputChars) fail(413, `Tu plan permite peticiones de hasta ${limits.maxInputChars} caracteres.`);
  const used = await usageToday(c.env.DB, user.id);
  if (used.chat >= limits.chatMessagesPerDay) fail(429, `Has usado los ${limits.chatMessagesPerDay} mensajes de hoy.`);
  const wait = await hit(c.env.DB, `chat:${user.id}`, 20, 60);
  if (wait) fail(429, `Vas muy rápido. Espera ${wait} s.`);
  const images = await ownedImages(c.env.DB, user.id, body.image_ids);
  const target = (body.target ?? {}) as Record<string, unknown>;
  let projectId: number | null = null;
  if (target.type === "project") {
    projectId = (await ownProject(c, String(target.id))).id;
  } else if (target.type === "new") {
    const name = str(target, "name", { label: "Nombre del proyecto", min: 1, max: 80 })!;
    const tpl = TEMPLATE_MAP.get(String(target.template ?? "custom")) ?? TEMPLATE_MAP.get("custom")!;
    const now = nowIso();
    projectId = await run(
      c.env.DB,
      "INSERT INTO projects (owner_id, name, description, objective, template, instructions, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      user.id, name, text.slice(0, 500), text.slice(0, 1000), tpl.id, tpl.instructions, tpl.color, now, now,
    );
    for (const m of tpl.memory) await run(c.env.DB, "INSERT INTO project_memory (project_id, kind, content, source, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?)", projectId, m.kind, m.content, now, now);
    await record(c.env.DB, { actor: user.email, userId: user.id, projectId, action: "proyecto.crear", target: name, detail: "desde el centro de comandos" });
  } else if (target.type !== "standalone") fail(422, "Destino no válido.");
  const threadId = await createThread(c.env.DB, user.id, { title: text.replace(/\s+/g, " ").slice(0, 60), projectId });
  const thread = await one<any>(c.env.DB, "SELECT * FROM chat_threads WHERE id = ?", threadId);
  const res = await startOrchestrated(c.env, user.id, sub.plan, thread, text, images);
  return c.json({ ...res, thread_id: threadId, project_id: projectId }, 202);
});

// --- Preferencias de interfaz (tema, dashboard, visuales de agentes) ---------------------------------

workspaceRoutes.get("/prefs", async (c) => {
  const row = await one<any>(c.env.DB, "SELECT prefs_json FROM user_prefs WHERE user_id = ?", c.get("user").id);
  return c.json(loads(row?.prefs_json, {}));
});

workspaceRoutes.put("/prefs", async (c) => {
  const body = await jsonBody(c.req.raw);
  const json = dumps(body);
  if (json.length > 20_000) fail(413, "Preferencias demasiado grandes.");
  await run(
    c.env.DB,
    "INSERT INTO user_prefs (user_id, prefs_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at",
    c.get("user").id, json, nowIso(),
  );
  return c.json(body);
});
