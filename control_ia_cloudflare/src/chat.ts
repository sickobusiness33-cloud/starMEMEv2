// AI CHAT central con Kairo.
//
// Modo por defecto (thread.mode = "auto"): cada mensaje lo procesa el AI
// ORCHESTRATOR en la cola; todos los agentes están disponibles y él decide
// cuáles usar. El progreso se sigue en tiempo real por SSE
// (/api/chat/runs/:id/stream). Con auto_mode = 0 el usuario elige agentes,
// modelo y herramientas (modo manual).
//
// Modos directos (sin orquestador, respuesta síncrona): router (Claude → gratis),
// claude (solo Claude), free (solo gratis) y agent:<id> (personalidad de un agente).

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { requireUser } from "./auth";
import { all, dumps, loads, nowIso, one, run } from "./db";
import type { AppEnv, Env } from "./env";
import { fail, jsonBody, objOf, reqStr, str, toId } from "./http";
import { ownedImages } from "./hub";
import { getSubscription, PLAN_LIMITS, usageToday, type PlanId } from "./plans";
import { hit } from "./ratelimit";
import { generate, RouterError } from "./ai/router";
import { MODEL_MAP, MODELS, publicModel } from "./ai/models";
import { getAgent, listAgents } from "./agents/registry";
import { CATEGORIES, TOOL_INFO } from "./agents/types";
import { BRAND } from "./orchestrator/brand";
import { runState, type ManualConfig } from "./orchestrator/executor";
import { orchestratorPool, roleOf } from "./orchestrator/planner";

export const chatRoutes = new Hono<AppEnv>();
chatRoutes.use("*", requireUser);

const SYSTEM =
  `Eres ${BRAND.name}, el asistente de Control IA. Responde en el idioma del usuario, ` +
  "de forma clara y útil, con formato Markdown sencillo cuando ayude. No inventes datos ni fuentes: si no lo sabes, dilo.";

const MODE = /^(auto|router|claude|free|agent:[a-z0-9][a-z0-9-]{1,59})$/;
const HISTORY = 12;
export const ACTIVE = ["queued", "planning", "running", "aggregating", "validating"];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));

export async function ownedProject(db: D1Database, userId: number, raw: unknown): Promise<number> {
  const p = await one<any>(db, "SELECT id FROM projects WHERE id = ? AND owner_id = ?", Number(raw), userId);
  if (!p) fail(404, "Proyecto no encontrado.");
  return p.id;
}

/** Nuevo chat: modo AUTO activado y todos los agentes disponibles (no hay que activarlos). */
export async function createThread(db: D1Database, userId: number, o: { title: string; mode?: string; projectId?: number | null }) {
  const now = nowIso();
  return run(db, "INSERT INTO chat_threads (user_id, title, mode, auto_mode, project_id, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)", userId, o.title, o.mode ?? "auto", o.projectId ?? null, now, now);
}

/** Envía un mensaje al orquestador (lo usan el chat y el centro de comandos). */
export async function startOrchestrated(env: Env, userId: number, plan: PlanId, t: any, content: string, images: number[]) {
  const busy = await one<any>(env.DB, `SELECT id FROM chat_runs WHERE thread_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`, t.id, ...ACTIVE);
  if (busy) fail(409, `${BRAND.name} aún está trabajando en tu mensaje anterior.`);
  const now = nowIso();
  const mid = await run(env.DB, "INSERT INTO chat_messages (thread_id, role, content, images_json, created_at) VALUES (?, 'user', ?, ?, ?)", t.id, content, dumps(images), now);
  const manual = t.auto_mode ? null : loads<ManualConfig>(t.manual_json, {});
  const runId = await run(
    env.DB,
    "INSERT INTO chat_runs (thread_id, user_id, message_id, status, mode, plan_json, plan, project_id, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
    t.id,
    userId,
    mid,
    manual ? "manual" : "auto",
    dumps(manual ? { manual } : { model: loads<ManualConfig>(t.manual_json, {}).model || undefined }),
    plan,
    t.project_id ?? null,
    now,
  );
  const title = t.title === "Nueva conversación" ? content.replace(/\s+/g, " ").slice(0, 60) : t.title;
  await run(env.DB, "UPDATE chat_threads SET mode = 'auto', title = ?, updated_at = ? WHERE id = ?", title, now, t.id);
  if (t.project_id) await run(env.DB, "UPDATE projects SET updated_at = ? WHERE id = ?", now, t.project_id);
  await env.RUNS.send({ chatRunId: runId });
  const message = await one<any>(env.DB, "SELECT * FROM chat_messages WHERE id = ?", mid);
  return { message: { ...message, images, images_json: undefined }, run: (await runState(env.DB, runId))!.run };
}

async function ownThread(c: Context<AppEnv>) {
  const row = await one<any>(c.env.DB, "SELECT * FROM chat_threads WHERE id = ? AND user_id = ?", toId(c.req.param("id")), c.get("user").id);
  if (!row) fail(404, "Conversación no encontrada.");
  return row;
}

function threadOut(t: any) {
  const { manual_json, ...rest } = t;
  return { ...rest, auto_mode: Boolean(t.auto_mode), manual: loads<ManualConfig>(manual_json, {}) };
}

/** Todos los agentes que el orquestador tiene a su disposición (se registran en cada chat). */
chatRoutes.get("/agents", async (c) => {
  const sub = await getSubscription(c.env.DB, c.get("user").id);
  const pool = orchestratorPool(await listAgents(c.env.DB), sub.plan);
  return c.json({
    brand: BRAND,
    plan: sub.plan,
    max_agents_per_message: PLAN_LIMITS[sub.plan].maxAgentsPerMessage,
    agents: pool.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      category: a.category,
      category_label: CAT_LABEL[a.category],
      color: a.color,
      tier: a.tier,
      locked: a.locked,
      needs_image: a.input.image === "required",
      tools: a.tools,
      capability: a.model.capability ?? "chat",
      role: roleOf(a),
      capabilities: a.capabilities,
    })),
    models: MODELS.filter((m) => m.kind === "text").map(publicModel),
    tools: Object.entries(TOOL_INFO).map(([id, t]) => ({ id, ...t })),
  });
});

/** Lo que hace cada agente de verdad (pantalla de su ordenador en la oficina): petición, salida y estado.
 *  ?ids=a,b,c → lo último de cada uno · ?ids=a&limit=10 → historial de uno. Solo datos del usuario. */
const AGENT_LIVE = new Set(["QUEUED", "ANALYZING", "THINKING", "SEARCHING", "PROCESSING", "GENERATING", "EXECUTING", "pending", "running"]);
chatRoutes.get("/agents-activity", async (c) => {
  const uid = c.get("user").id;
  const ids = String(c.req.query("ids") || "").split(",").map((x) => x.trim()).filter((x) => /^[a-z0-9-]{1,80}$/.test(x)).slice(0, 40);
  if (!ids.length) return c.json({ agents: {} });
  const limit = ids.length === 1 ? Math.max(1, Math.min(20, Number(c.req.query("limit") || 8))) : 1;
  const ph = ids.map(() => "?").join(",");
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const chat = await all<any>(c.env.DB,
    `SELECT a.agent_id, a.status, a.action, a.progress, a.task, substr(a.result, 1, 6000) AS output, a.provider, a.model, a.started_at, a.finished_at, a.execution_ms,
       r.id AS run_id, r.thread_id, substr(m.content, 1, 2000) AS request, COALESCE(a.started_at, r.created_at) AS at
     FROM chat_run_agents a JOIN chat_runs r ON r.id = a.run_id LEFT JOIN chat_messages m ON m.id = r.message_id
     WHERE r.user_id = ? AND a.agent_id IN (${ph}) AND r.created_at >= ? ORDER BY a.id DESC LIMIT ?`, uid, ...ids, since, limit * ids.length * 3);
  const hub = await all<any>(c.env.DB,
    `SELECT agent_id, status, stage AS action, substr(input, 1, 2000) AS request, substr(output, 1, 6000) AS output, output_kind, error, started_at, finished_at, created_at AS at, id AS hub_run_id
     FROM agent_runs WHERE user_id = ? AND agent_id IN (${ph}) AND created_at >= ? ORDER BY id DESC LIMIT ?`, uid, ...ids, since, limit * ids.length * 3);
  const out: Record<string, any[]> = {};
  for (const r of [...chat.map((x) => ({ ...x, source: "kairo" })), ...hub.map((x) => ({ ...x, source: "hub", output: x.output_kind === "image" ? "[imagen generada]" : x.output }))]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))) {
    const list = (out[r.agent_id] ||= []);
    if (list.length < limit) list.push({ ...r, live: AGENT_LIVE.has(r.status) });
  }
  return c.json({ agents: out });
});

chatRoutes.get("/threads", async (c) => {
  const pid = Number(c.req.query("project_id") || 0);
  // Historial de chat separado de los datos del proyecto: la lista global no mezcla los chats de proyectos.
  const rows = pid
    ? await all(c.env.DB, "SELECT * FROM chat_threads WHERE user_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT 50", c.get("user").id, pid)
    : await all(c.env.DB, "SELECT * FROM chat_threads WHERE user_id = ? AND project_id IS NULL ORDER BY updated_at DESC LIMIT 50", c.get("user").id);
  return c.json(rows.map(threadOut));
});

chatRoutes.post("/threads", async (c) => {
  const body = await jsonBody(c.req.raw);
  const mode = str(body, "mode", { label: "Modo", max: 70, pattern: MODE, optional: true }) ?? "auto";
  const title = str(body, "title", { label: "Título", max: 80, optional: true }) || "Nueva conversación";
  const projectId = body.project_id ? await ownedProject(c.env.DB, c.get("user").id, body.project_id) : null;
  const id = await createThread(c.env.DB, c.get("user").id, { title, mode, projectId });
  return c.json(threadOut(await one(c.env.DB, "SELECT * FROM chat_threads WHERE id = ?", id)), 201);
});

chatRoutes.get("/threads/:id", async (c) => {
  const t = await ownThread(c);
  const messages = await all<any>(c.env.DB, "SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 200", t.id);
  const active = await one<any>(c.env.DB, `SELECT id FROM chat_runs WHERE thread_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`, t.id, ...ACTIVE);
  const lastRun = await one<any>(c.env.DB, "SELECT id FROM chat_runs WHERE thread_id = ? ORDER BY id DESC LIMIT 1", t.id);
  return c.json({
    ...threadOut(t),
    messages: messages.reverse().map((m) => ({ ...m, images: loads(m.images_json, []), images_json: undefined })),
    active_run_id: active?.id ?? null,
    last_run_id: lastRun?.id ?? null,
  });
});

chatRoutes.patch("/threads/:id", async (c) => {
  const t = await ownThread(c);
  const body = await jsonBody(c.req.raw);
  const mode = str(body, "mode", { label: "Modo", max: 70, pattern: MODE, optional: true }) ?? t.mode;
  const title = str(body, "title", { label: "Título", min: 1, max: 80, optional: true }) ?? t.title;
  const autoMode = body.auto_mode === undefined ? t.auto_mode : body.auto_mode ? 1 : 0;
  let manual = loads<ManualConfig>(t.manual_json, {});
  if (body.manual !== undefined) {
    const m = objOf(body, "manual") as any;
    const sub = await getSubscription(c.env.DB, c.get("user").id);
    const pool = new Map(orchestratorPool(await listAgents(c.env.DB), sub.plan).map((a) => [a.id, a]));
    const agents: string[] = Array.isArray(m.agents) ? [...new Set<string>(m.agents.map(String))] : [];
    if (agents.length > PLAN_LIMITS[sub.plan].maxAgentsPerMessage) fail(422, `Tu plan permite hasta ${PLAN_LIMITS[sub.plan].maxAgentsPerMessage} agentes por mensaje.`);
    for (const id of agents) {
      const a = pool.get(id);
      if (!a) fail(422, `El agente «${id}» no existe.`);
      if (a!.locked) fail(402, `«${a!.name}» es un agente premium: requiere Control IA Pro.`);
    }
    const model = m.model ? String(m.model) : null;
    if (model && MODEL_MAP.get(model)?.kind !== "text") fail(422, "Modelo no válido.");
    const toolsOff: string[] = Array.isArray(m.tools_off) ? [...new Set<string>(m.tools_off.map(String))].filter((x) => x in TOOL_INFO) : [];
    manual = { agents, model, tools_off: toolsOff };
  }
  await run(c.env.DB, "UPDATE chat_threads SET mode = ?, title = ?, auto_mode = ?, manual_json = ?, updated_at = ? WHERE id = ?", mode, title, autoMode, dumps(manual), nowIso(), t.id);
  return c.json(threadOut(await one(c.env.DB, "SELECT * FROM chat_threads WHERE id = ?", t.id)));
});

chatRoutes.delete("/threads/:id", async (c) => {
  const t = await ownThread(c);
  await run(c.env.DB, "DELETE FROM chat_threads WHERE id = ?", t.id);
  return c.json({ ok: true });
});

chatRoutes.post("/threads/:id/messages", async (c) => {
  const user = c.get("user");
  const t = await ownThread(c);
  const body = await jsonBody(c.req.raw);
  const mode = str(body, "mode", { label: "Modo", max: 70, pattern: MODE, optional: true }) ?? t.mode;
  const sub = await getSubscription(c.env.DB, user.id);
  const limits = PLAN_LIMITS[sub.plan];
  const content = reqStr(body, "content", { label: "Mensaje", min: 1, max: 40_000 });
  if (content.length > limits.maxInputChars) fail(413, `Tu plan permite mensajes de hasta ${limits.maxInputChars.toLocaleString("es-ES")} caracteres.`);
  const images = await ownedImages(c.env.DB, user.id, body.image_ids);
  const used = await usageToday(c.env.DB, user.id);
  if (used.chat >= limits.chatMessagesPerDay) {
    fail(429, `Has usado los ${limits.chatMessagesPerDay} mensajes de chat de hoy.${sub.plan === "free" ? " Pro amplía el límite." : ""}`);
  }
  const wait = await hit(c.env.DB, `chat:${user.id}`, 20, 60);
  if (wait) fail(429, `Vas muy rápido. Espera ${wait} s.`);
  const now = nowIso();
  const title = t.title === "Nueva conversación" ? content.replace(/\s+/g, " ").slice(0, 60) : t.title;

  // --- Kairo: orquestador multiagente ---
  if (mode === "auto") return c.json(await startOrchestrated(c.env, user.id, sub.plan, t, content, images), 202);

  // --- Modos directos (síncronos) ---
  let system = SYSTEM;
  let agentId: string | null = null;
  let prefer: "premium" | "free" = "premium";
  let allowFallback = true;
  let advanced = false;
  if (mode === "free") prefer = "free";
  if (mode === "claude") allowFallback = false;
  if (mode.startsWith("agent:")) {
    const a = await getAgent(c.env.DB, mode.slice(6));
    if (!a) fail(404, "Ese agente ya no está en el Hub.");
    if (a!.tier === "pro" && !limits.premiumAgents) fail(402, `«${a!.name}» es un agente premium: requiere Control IA Pro.`);
    system = `${a!.instructions}\n\nEstás conversando en el chat de Control IA como el agente «${a!.name}».`;
    agentId = a!.id;
    prefer = a!.model.prefer;
    allowFallback = a!.model.allowFallback;
    advanced = Boolean(a!.model.advanced);
  }
  await run(c.env.DB, "INSERT INTO chat_messages (thread_id, role, content, agent_id, images_json, created_at) VALUES (?, 'user', ?, ?, ?, ?)", t.id, content, agentId, dumps(images), now);
  const history = (await all<any>(c.env.DB, "SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?", t.id, HISTORY)).reverse();
  let budget = limits.maxInputChars * 3;
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    budget -= history[i].content.length;
    if (budget < 0 && messages.length) break;
    messages.unshift({ role: history[i].role, content: history[i].content });
  }
  while (messages.length && messages[0].role !== "user") messages.shift();
  await run(c.env.DB, "UPDATE chat_threads SET mode = ?, title = ?, updated_at = ? WHERE id = ?", mode, title, now, t.id);
  try {
    const res = await generate(
      { env: c.env, userId: user.id, plan: sub.plan, kind: "chat", agentId },
      { system, messages, maxTokens: limits.maxOutputTokens, prefer, allowFallback, advanced },
    );
    const notice = res.notices.join(" · ") || null;
    const mid = await run(
      c.env.DB,
      "INSERT INTO chat_messages (thread_id, role, content, provider, model, fallback, notice, agent_id, created_at) VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?)",
      t.id,
      res.text,
      res.provider,
      res.model,
      res.fallback ? 1 : 0,
      notice,
      agentId,
      nowIso(),
    );
    return c.json({ message: await one(c.env.DB, "SELECT * FROM chat_messages WHERE id = ?", mid), latency_ms: res.latencyMs }, 201);
  } catch (err) {
    if (err instanceof RouterError) fail(err.code === "premium_unavailable" ? 409 : 502, err.message);
    throw err;
  }
});

// --- Ejecuciones del orquestador (Activity Panel) -----------------------------------------------

async function ownRun(c: Context<AppEnv>) {
  const r = await one<any>(c.env.DB, "SELECT id, status FROM chat_runs WHERE id = ? AND user_id = ?", toId(c.req.param("id")), c.get("user").id);
  if (!r) fail(404, "Ejecución no encontrada.");
  return r;
}

chatRoutes.get("/runs/:id", async (c) => {
  const r = await ownRun(c);
  return c.json(await runState(c.env.DB, r.id));
});

chatRoutes.post("/runs/:id/cancel", async (c) => {
  const r = await ownRun(c);
  if (!ACTIVE.includes(r.status)) fail(409, "Esta ejecución ya terminó.");
  await run(c.env.DB, `UPDATE chat_runs SET status = 'cancelled', finished_at = ?, version = version + 1 WHERE id = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`, nowIso(), r.id, ...ACTIVE);
  return c.json(await runState(c.env.DB, r.id));
});

/**
 * Tiempo real: Server-Sent Events. El servidor comprueba la versión de la
 * ejecución cada 400 ms (una lectura ligera en D1) y solo envía el estado
 * completo cuando cambia. El navegador no hace polling.
 */
chatRoutes.get("/runs/:id/stream", async (c) => {
  const r = await ownRun(c);
  const db = c.env.DB;
  return streamSSE(c, async (stream) => {
    let version = -1;
    const t0 = Date.now();
    while (!stream.aborted && Date.now() - t0 < 180_000) {
      const v = await one<any>(db, "SELECT version, status FROM chat_runs WHERE id = ?", r.id);
      if (!v) break;
      if (v.version !== version) {
        version = v.version;
        await stream.writeSSE({ event: "state", data: JSON.stringify(await runState(db, r.id)), id: String(version) });
      }
      if (!ACTIVE.includes(v.status)) {
        await stream.writeSSE({ event: "done", data: v.status });
        break;
      }
      await stream.sleep(400);
    }
  });
});
