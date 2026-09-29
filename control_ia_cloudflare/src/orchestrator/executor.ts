// AI ORCHESTRATOR · ejecución.
//
//   PETICIÓN → PLAN (planner) → DAG de agentes
//     · pasos sin dependencias pendientes → en PARALELO
//     · pasos con depends_on → esperan (QUEUED) y reciben solo esos resultados
//   → RESULTADOS ESTRUCTURADOS {agent, status, confidence, result, metadata, executionTime}
//   → AGREGADOR (una sola respuesta coherente) → mensaje final
//
// Cada cambio de estado se guarda en chat_run_agents y sube chat_runs.version;
// el stream SSE (/api/chat/runs/:id/stream) lo envía al Activity Panel.

import { generate, RouterError, type CallContext, type ChatMsg } from "../ai/router";
import { runStage } from "../agents/pipeline";
import { listAgents, type RegistryAgent } from "../agents/registry";
import type { Stage } from "../agents/types";
import { redact } from "../crypto";
import { all, dumps, loads, nowIso, one, run } from "../db";
import type { Env } from "../env";
import { notify } from "../notify";
import { PLAN_LIMITS, type PlanId } from "../plans";
import { KAIRO_SYSTEM } from "./brand";
import { projectContext, type ProjectContext } from "./context";
import { chainByClass, classify, defaultWhy, orchestratorPool, planWithLLM, planWithRules, roleOf, type Plan, type PlanStep, type PoolAgent } from "./planner";

export type AgentStatus = "IDLE" | "QUEUED" | "ANALYZING" | "THINKING" | "SEARCHING" | "PROCESSING" | "GENERATING" | "EXECUTING" | "COMPLETED" | "ERROR";

export interface AgentResult {
  agent: string;
  status: "completed" | "error" | "skipped";
  confidence: number;
  result: string;
  metadata: { provider?: string; model?: string; fallback?: boolean; notices?: string[]; images?: number[]; confidence_method: "heuristic" };
  executionTime: number;
}

export interface ManualConfig {
  agents?: string[];
  model?: string | null;
  tools_off?: string[];
}

class Cancelled extends Error {}

/** Agentes que reciben historial del chat (context filtering: el resto solo ve su tarea). */
const HISTORY_CATEGORIES = new Set(["general", "writing", "productivity", "social", "marketing", "business"]);
const IMAGE_TOOLS = new Set(["image_edit", "image_variation", "vision_describe"]);

function stageStatus(s: Exclude<Stage, { kind: "agents" }>): [AgentStatus, string] {
  if (s.kind === "tool") {
    switch (s.tool) {
      case "wikipedia_search":
        return ["SEARCHING", "Consultando Wikipedia"];
      case "web_read":
        return ["SEARCHING", "Leyendo páginas web"];
      case "vision_describe":
        return ["ANALYZING", "Analizando la imagen"];
      case "image_generate":
        return ["GENERATING", "Generando imagen"];
      case "image_edit":
        return ["GENERATING", "Editando imagen"];
      case "image_variation":
        return ["GENERATING", "Creando variación"];
    }
  }
  if (s.id === "planning") return ["THINKING", `Pensando · ${s.label}`];
  if (s.id === "analyzing") return ["ANALYZING", `Analizando · ${s.label}`];
  if (s.id === "generating") return ["GENERATING", `Redactando · ${s.label}`];
  return ["PROCESSING", s.label];
}

/** Confianza heurística y verificable (no la inventa un modelo). */
function confidenceOf(text: string, fallback: boolean, toolMisses: number) {
  let c = 0.9;
  if (fallback) c -= 0.15;
  c -= 0.2 * toolMisses;
  if (text.trim().length < 80) c -= 0.2;
  return Math.round(Math.max(0.1, Math.min(0.95, c)) * 100) / 100;
}

interface Ctx {
  env: Env;
  runId: number;
  t0: number;
  project: ProjectContext | null;
  userId: number;
  plan: PlanId;
  request: string;
  history: ChatMsg[];
  images: number[];
  manual: ManualConfig | null;
  /** Modelo de texto elegido por el usuario (modo manual o selector de modelo en modo auto). */
  model: string | null;
  notices: string[];
}

async function bump(env: Env, runId: number, fields: Record<string, unknown> = {}) {
  const keys = Object.keys(fields);
  await env.DB.prepare(`UPDATE chat_runs SET ${[...keys.map((k) => `${k} = ?`), "version = version + 1"].join(", ")} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), runId)
    .run();
}

/** Tipos de evento (fuente única para la red de agentes, timeline, Mission Control y replay). */
export type EventType =
  | "RUN_STARTED" | "PLAN_CREATED" | "RUN_COMPLETED" | "RUN_FAILED" | "RUN_CANCELLED"
  | "TASK_CREATED" | "TASK_STARTED" | "TASK_COMPLETED" | "TASK_FAILED"
  | "AGENT_STARTED" | "AGENT_WORKING" | "AGENT_WAITING" | "AGENT_COMPLETED" | "AGENT_ERROR"
  | "VALIDATION_STARTED" | "VALIDATION_COMPLETED";

async function emit(
  c: { env: Env; runId: number; t0: number },
  type: EventType,
  e: { step?: string | null; agent?: string | null; status?: string | null; action?: string | null; progress?: number | null; data?: unknown } = {},
) {
  await run(
    c.env.DB,
    "INSERT INTO run_events (run_id, ts, ms, type, step, agent_id, status, action, progress, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    c.runId,
    nowIso(),
    Math.max(0, Date.now() - c.t0),
    type,
    e.step ?? null,
    e.agent ?? null,
    e.status ?? null,
    e.action ? String(e.action).slice(0, 300) : null,
    e.progress ?? null,
    dumps(e.data ?? {}),
  );
}

const STATUS_EVENT: Record<string, EventType> = { EXECUTING: "AGENT_STARTED", QUEUED: "AGENT_WAITING", COMPLETED: "AGENT_COMPLETED", ERROR: "AGENT_ERROR" };

async function setAgent(c: Ctx, rowId: number, fields: Record<string, unknown>) {
  if (fields.status) {
    const row = await one<any>(c.env.DB, "SELECT step, agent_id FROM chat_run_agents WHERE id = ?", rowId);
    const type = STATUS_EVENT[String(fields.status)] ?? "AGENT_WORKING";
    await emit(c, type, { step: row?.step, agent: row?.agent_id, status: String(fields.status), action: (fields.action as string) ?? null, progress: (fields.progress as number) ?? null });
    if (type === "AGENT_STARTED") await emit(c, "TASK_STARTED", { step: row?.step, agent: row?.agent_id });
    if (type === "AGENT_COMPLETED") await emit(c, "TASK_COMPLETED", { step: row?.step, agent: row?.agent_id, data: { execution_ms: fields.execution_ms, confidence: fields.confidence } });
    if (type === "AGENT_ERROR") await emit(c, "TASK_FAILED", { step: row?.step, agent: row?.agent_id, action: (fields.action as string) ?? null });
  }
  const keys = Object.keys(fields);
  await c.env.DB.prepare(`UPDATE chat_run_agents SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), rowId)
    .run();
  await bump(c.env, c.runId);
}

async function checkCancelled(c: Ctx) {
  const r = await one<any>(c.env.DB, "SELECT status FROM chat_runs WHERE id = ?", c.runId);
  if (r?.status === "cancelled") throw new Cancelled();
}

function stageClassOf(agent: RegistryAgent) {
  const tools = agent.stages.filter((s) => s.kind === "tool").map((s) => (s as any).tool as string);
  return tools.some((t) => t.startsWith("image_")) ? 2 : 1;
}

function note(c: Ctx, list: string[]) {
  for (const n of list) if (!c.notices.includes(n)) c.notices.push(n);
}

function historyText(history: ChatMsg[], maxChars = 2500) {
  let out = "";
  for (const m of [...history].reverse()) {
    const line = `${m.role === "user" ? "Usuario" : "Kairo"}: ${(typeof m.content === "string" ? m.content : "").slice(0, 600)}\n`;
    if (out.length + line.length > maxChars) break;
    out = line + out;
  }
  return out.trim();
}

/** Context filtering: cada agente recibe su tarea, la petición y SOLO lo que necesita. */
function agentInput(c: Ctx, agent: RegistryAgent, step: PlanStep, deps: { name: string; result: AgentResult }[]) {
  const parts = [`Tarea asignada por Kairo: ${step.task}`, `Petición original del usuario:\n${c.request}`];
  // Context filtering: el contexto del proyecto (objetivo, memoria fijada, instrucciones) va a todos;
  // el contenido de archivos solo a los agentes que analizan o producen, no a los de imagen.
  if (c.project) parts.push(`Contexto del proyecto «${c.project.name}»:\n${c.project.text}`);
  if (c.project?.files && stageClassOf(agent) < 2) parts.push(`Archivos del proyecto (extracto):\n${c.project.files}`);
  if (deps.length) {
    parts.push(
      "Resultados de los agentes de los que dependes:\n" +
        deps.map((d) => `### ${d.name} (${d.result.status}, confianza ${d.result.confidence})\n${d.result.result.slice(0, 3000)}`).join("\n\n"),
    );
  }
  if (HISTORY_CATEGORIES.has(agent.category) && c.history.length) parts.push(`Contexto reciente de la conversación:\n${historyText(c.history, 1500)}`);
  return parts.join("\n\n");
}

async function runAgentStep(c: Ctx, agent: RegistryAgent, step: PlanStep, rowId: number, deps: { name: string; result: AgentResult }[]): Promise<AgentResult> {
  const t0 = Date.now();
  const ctx: CallContext = { env: c.env, userId: c.userId, plan: c.plan, kind: "orchestrator", agentId: agent.id };
  const input = agentInput(c, agent, step, deps);
  const outputs: Record<string, string> = {};
  const stages = agent.stages.filter((s): s is Exclude<Stage, { kind: "agents" }> => s.kind !== "agents");
  const usesImages = agent.stages.some((s) => s.kind === "tool" && IMAGE_TOOLS.has((s as any).tool));
  let last = "";
  let provider: string | undefined;
  let model: string | undefined;
  let fallback = false;
  let toolMisses = 0;
  const images: number[] = [];
  const stageNotices: string[] = [];
  await setAgent(c, rowId, { status: "EXECUTING", action: "Preparando contexto", started_at: nowIso(), progress: 2 });
  for (let i = 0; i < stages.length; i++) {
    await checkCancelled(c);
    const s = stages[i];
    const [status, action] = stageStatus(s);
    await setAgent(c, rowId, { status, action, progress: Math.round((i / stages.length) * 100) || 4 });
    const res = await runStage(
      {
        ctx,
        agent,
        input,
        userInput: c.request,
        outputs,
        tools: usesImages ? { images: c.images } : {},
        model: c.model ?? undefined,
        disabledTools: new Set(c.manual?.tools_off ?? []),
      },
      s,
    );
    outputs[s.id] = res.text;
    stageNotices.push(...res.notices);
    if (s.kind === "llm") {
      last = res.text;
      provider = res.provider;
      model = res.model;
      fallback ||= Boolean(res.fallback);
      await setAgent(c, rowId, { provider, model, fallback: fallback ? 1 : 0 });
    } else {
      if (/No se encontraron|no se pudo|No hay ninguna imagen|desactivada/i.test(res.text)) toolMisses++;
      if (res.image?.id) images.push(res.image.id);
      if (res.model) {
        provider ||= res.provider;
        model ||= res.model;
        await setAgent(c, rowId, { provider: provider ?? null, model: model ?? null });
      }
      if (i === stages.length - 1) last = res.text;
    }
  }
  note(c, stageNotices);
  const executionTime = Date.now() - t0;
  return {
    agent: agent.id,
    status: "completed",
    confidence: confidenceOf(last, fallback, toolMisses),
    result: last,
    metadata: { provider, model, fallback, notices: stageNotices, images, confidence_method: "heuristic" },
    executionTime,
  };
}

/** Ejecuta el DAG: todo lo que está listo corre en paralelo. */
async function executePlan(c: Ctx, plan: Plan, byId: Map<string, RegistryAgent>, rows: Map<string, number>) {
  const results = new Map<string, AgentResult>();
  const pending = new Set(plan.steps.map((s) => s.id));
  const running = new Map<string, Promise<void>>();
  const stepById = new Map(plan.steps.map((s) => [s.id, s]));
  while (pending.size || running.size) {
    for (const id of [...pending]) {
      const step = stepById.get(id)!;
      const depsFailed = step.depends_on.filter((d) => results.has(d) && results.get(d)!.status !== "completed");
      const depsReady = step.depends_on.every((d) => results.has(d));
      if (!depsReady) continue;
      pending.delete(id);
      const agent = byId.get(step.agent)!;
      if (depsFailed.length) {
        const r: AgentResult = { agent: agent.id, status: "skipped", confidence: 0, result: "", metadata: { confidence_method: "heuristic" }, executionTime: 0 };
        results.set(id, r);
        await setAgent(c, rows.get(id)!, { status: "ERROR", action: `Omitido: falló ${depsFailed.map((d) => byId.get(stepById.get(d)!.agent)!.name).join(", ")}`, finished_at: nowIso() });
        continue;
      }
      const deps = step.depends_on.map((d) => ({ name: byId.get(stepById.get(d)!.agent)!.name, result: results.get(d)! }));
      const p = runAgentStep(c, agent, step, rows.get(id)!, deps)
        .then(async (r) => {
          results.set(id, r);
          await setAgent(c, rows.get(id)!, {
            status: "COMPLETED",
            action: "Completado",
            progress: 100,
            confidence: r.confidence,
            result: r.result.slice(0, 20_000),
            metadata_json: dumps(r.metadata),
            finished_at: nowIso(),
            execution_ms: r.executionTime,
          });
        })
        .catch(async (err) => {
          if (err instanceof Cancelled) {
            results.set(id, { agent: agent.id, status: "error", confidence: 0, result: "", metadata: { confidence_method: "heuristic" }, executionTime: 0 });
            await setAgent(c, rows.get(id)!, { status: "ERROR", action: "Cancelado", finished_at: nowIso() });
            return;
          }
          const msg = err instanceof RouterError ? err.message : redact(err instanceof Error ? err.message : String(err)).slice(0, 200);
          results.set(id, { agent: agent.id, status: "error", confidence: 0, result: `Error: ${msg}`, metadata: { confidence_method: "heuristic" }, executionTime: 0 });
          await setAgent(c, rows.get(id)!, { status: "ERROR", action: msg, finished_at: nowIso() });
        })
        .finally(() => running.delete(id));
      running.set(id, p);
    }
    if (running.size) await Promise.race(running.values());
    else if (pending.size) {
      // Dependencias imposibles (no debería ocurrir tras validar): se marcan y se sale.
      for (const id of pending) await setAgent(c, rows.get(id)!, { status: "ERROR", action: "Dependencia no resuelta" });
      break;
    }
  }
  return results;
}

async function aggregate(c: Ctx, plan: Plan, byId: Map<string, RegistryAgent>, results: Map<string, AgentResult>) {
  const ctx: CallContext = { env: c.env, userId: c.userId, plan: c.plan, kind: "orchestrator", agentId: null };
  const ok = plan.steps.map((s) => ({ step: s, r: results.get(s.id)! })).filter((x) => x.r?.status === "completed");
  const images = ok.flatMap((x) => (x.r.metadata.images ?? []).map((id) => ({ id, agent: x.step.agent })));
  const failed = plan.steps.filter((s) => results.get(s.id)?.status !== "completed").map((s) => byId.get(s.agent)!.name);
  if (!ok.length) throw new RouterError(`Ningún agente pudo completar su parte (${failed.join(", ")}).`, "agents_failed");
  // Un único agente de texto: su resultado ya es la respuesta (sin llamada extra = menos latencia).
  if (ok.length === 1 && !failed.length) {
    const r = ok[0].r;
    return { text: r.result, provider: r.metadata.provider ?? null, model: r.metadata.model ?? null, fallback: Boolean(r.metadata.fallback), images };
  }
  const structured = ok.map((x) => ({
    agent: byId.get(x.step.agent)!.name,
    task: x.step.task,
    confidence: x.r.confidence,
    result: x.r.result.slice(0, 5000),
    images: (x.r.metadata.images ?? []).length,
  }));
  const prompt =
    `Petición del usuario:\n${c.request}\n\nResultados estructurados de tus agentes:\n${JSON.stringify(structured, null, 1)}\n\n` +
    (failed.length ? `Agentes que no pudieron completar su parte: ${failed.join(", ")}.\n\n` : "") +
    (images.length ? `Se han generado ${images.length} imagen(es); se adjuntan automáticamente a tu respuesta.\n\n` : "") +
    "Escribe la respuesta final para el usuario: integra los resultados en un único texto coherente, sin repetir contenido, " +
    "resolviendo contradicciones (di cuál es más fiable y por qué) y señalando lo que falte. No menciones JSON ni el formato interno.";
  try {
    const res = await generate(ctx, {
      system: systemFor(c),
      messages: [{ role: "user", content: prompt }],
      maxTokens: PLAN_LIMITS[c.plan].maxOutputTokens,
      prefer: "premium",
      allowFallback: true,
      capability: "chat",
      model: c.model ?? undefined,
    });
    note(c, res.notices);
    return { text: res.text, provider: res.provider, model: res.model, fallback: res.fallback || ok.some((x) => x.r.metadata.fallback), images };
  } catch {
    // Si el agregador falla, el usuario recibe igualmente los resultados ordenados.
    note(c, ["El agregador no respondió · se muestran los resultados de cada agente"]);
    const text = ok.map((x) => `### ${byId.get(x.step.agent)!.name}\n${x.r.result}`).join("\n\n");
    return { text, provider: null, model: null, fallback: true, images };
  }
}

function systemFor(c: Ctx) {
  return c.project ? `${KAIRO_SYSTEM}\n\nTrabajas dentro del proyecto «${c.project.name}». Tenlo en cuenta:\n${c.project.text}` : KAIRO_SYSTEM;
}

/**
 * VALIDACIÓN: un revisor comprueba el borrador final contra la petición y el
 * contexto del proyecto. Si encuentra problemas concretos, Kairo corrige el
 * borrador una vez. Solo en ejecuciones con varios agentes (las simples no lo necesitan).
 */
async function validate(c: Ctx, draft: { text: string; provider: any; model: any; fallback: boolean; images: any[] }, deps: string[]) {
  const ctx: CallContext = { env: c.env, userId: c.userId, plan: c.plan, kind: "orchestrator", agentId: "kairo-reviewer" };
  const rowId = await run(
    c.env.DB,
    "INSERT INTO chat_run_agents (run_id, step, agent_id, task, depends_json, status, action, role, why) VALUES (?, 'review', 'kairo-reviewer', ?, ?, 'QUEUED', 'Esperando el borrador', 'REVIEWER', ?)",
    c.runId,
    "Revisar que la respuesta cumple la petición, es coherente y no se contradice.",
    dumps(deps),
    "Se activa automáticamente cuando colaboran varios agentes: comprueba coherencia, contradicciones y que se responde a lo pedido.",
  );
  await emit(c, "VALIDATION_STARTED", { step: "review", agent: "kairo-reviewer" });
  const t0 = Date.now();
  await setAgent(c, rowId, { status: "EXECUTING", action: "Revisando el resultado", started_at: nowIso(), progress: 10 });
  let out = draft;
  let verdict = { ok: true, issues: [] as string[], parsed: false };
  try {
    const res = await generate(ctx, {
      system: "[reviewer] Eres un revisor exigente. Respondes SOLO con JSON válido.",
      messages: [{
        role: "user",
        content:
          `Petición del usuario:\n${c.request}\n\n${c.project ? `Contexto del proyecto:\n${c.project.text}\n\n` : ""}Borrador de respuesta:\n${draft.text.slice(0, 7000)}\n\n` +
          'Comprueba: ¿responde a lo pedido?, ¿hay contradicciones, datos inventados o partes que falten?, ¿respeta el contexto del proyecto? Formato: {"ok": true|false, "issues": ["problema concreto", ...]}',
      }],
      maxTokens: 400,
      prefer: "free",
      allowFallback: true,
      capability: "chat",
    });
    await setAgent(c, rowId, { status: "ANALYZING", action: "Comprobando coherencia", progress: 60, provider: res.provider, model: res.model });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]);
        verdict = { ok: j.ok !== false, issues: Array.isArray(j.issues) ? j.issues.map(String).slice(0, 5) : [], parsed: true };
      } catch {
        /* se entrega el borrador */
      }
    }
    if (!verdict.ok && verdict.issues.length) {
      await setAgent(c, rowId, { status: "GENERATING", action: `Corrigiendo ${verdict.issues.length} observación(es)`, progress: 80 });
      const fix = await generate(ctx, {
        system: systemFor(c),
        messages: [{ role: "user", content: `Petición:\n${c.request}\n\nBorrador:\n${draft.text}\n\nObservaciones del revisor:\n- ${verdict.issues.join("\n- ")}\n\nEntrega la respuesta final corregida (sin mencionar la revisión).` }],
        maxTokens: PLAN_LIMITS[c.plan].maxOutputTokens,
        prefer: "premium",
        allowFallback: true,
        capability: "chat",
      });
      out = { ...draft, text: fix.text, provider: fix.provider, model: fix.model };
    }
    const summary = !verdict.parsed ? "Revisión completada sin observaciones estructuradas" : verdict.ok ? "Aprobado sin observaciones" : `Corregido: ${verdict.issues.length} observación(es)`;
    await setAgent(c, rowId, { status: "COMPLETED", action: summary, progress: 100, result: verdict.issues.join("\n") || summary, confidence: verdict.ok ? 0.9 : 0.75, finished_at: nowIso(), execution_ms: Date.now() - t0, metadata_json: dumps({ issues: verdict.issues, confidence_method: "heuristic" }) });
    await emit(c, "VALIDATION_COMPLETED", { step: "review", agent: "kairo-reviewer", action: summary, data: { ok: verdict.ok, issues: verdict.issues } });
  } catch (err) {
    // La validación nunca bloquea la respuesta: si falla, se entrega el borrador y se indica.
    await setAgent(c, rowId, { status: "ERROR", action: "No se pudo revisar; se entrega el borrador", finished_at: nowIso(), execution_ms: Date.now() - t0 });
    note(c, ["La revisión automática no estuvo disponible"]);
  }
  return out;
}

async function direct(c: Ctx) {
  const ctx: CallContext = { env: c.env, userId: c.userId, plan: c.plan, kind: "orchestrator", agentId: null };
  const messages: ChatMsg[] = [...c.history.slice(-10), { role: "user", content: c.request }];
  while (messages.length && messages[0].role !== "user") messages.shift();
  const res = await generate(ctx, {
    system: systemFor(c),
    messages,
    maxTokens: PLAN_LIMITS[c.plan].maxOutputTokens,
    prefer: "premium",
    allowFallback: true,
    capability: "chat",
    model: c.model ?? undefined,
  });
  note(c, res.notices);
  return { text: res.text, provider: res.provider, model: res.model, fallback: res.fallback, images: [] as { id: number; agent: string }[] };
}

/** Consumidor de la cola: procesa un mensaje del chat con el orquestador. */
export async function processChatRun(env: Env, runId: number) {
  const runRow = await one<any>(env.DB, "SELECT * FROM chat_runs WHERE id = ?", runId);
  if (!runRow || runRow.status !== "queued") return;
  const claimed = await env.DB.prepare("UPDATE chat_runs SET status = 'planning', started_at = ?, version = version + 1 WHERE id = ? AND status = 'queued'").bind(nowIso(), runId).run();
  if (!claimed.meta.changes) return;
  const msg = await one<any>(env.DB, "SELECT * FROM chat_messages WHERE id = ?", runRow.message_id);
  const prev = await all<any>(env.DB, "SELECT role, content FROM chat_messages WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT 10", runRow.thread_id, runRow.message_id);
  const plan: PlanId = runRow.plan === "pro" ? "pro" : "free";
  const c: Ctx = {
    env,
    runId,
    t0: Date.now(),
    project: runRow.project_id ? await projectContext(env.DB, runRow.project_id, runRow.user_id) : null,
    userId: runRow.user_id,
    plan,
    request: msg?.content ?? "",
    history: prev.reverse().map((m) => ({ role: m.role, content: m.content })),
    images: loads<number[]>(msg?.images_json, []),
    manual: runRow.mode === "manual" ? ((loads<any>(runRow.plan_json, {}).manual ?? {}) as ManualConfig) : null,
    model: (runRow.mode === "manual" ? loads<any>(runRow.plan_json, {}).manual?.model : loads<any>(runRow.plan_json, {}).model) ?? null,
    notices: [],
  };
  const t0 = c.t0;
  await emit(c, "RUN_STARTED", { action: c.project ? `Petición en el proyecto «${c.project.name}»` : "Petición recibida" });
  try {
    const all_ = await listAgents(env.DB);
    const pool = orchestratorPool(all_, plan);
    const poolMap = new Map<string, PoolAgent>(pool.map((a) => [a.id, a]));
    const byId = new Map<string, RegistryAgent>(pool.map((a) => [a.id, a]));
    const max = PLAN_LIMITS[plan].maxAgentsPerMessage;

    // 1-2. ANALIZAR LA PETICIÓN Y SELECCIONAR AGENTES
    let planObj: Plan;
    if (c.manual) {
      const ids = (c.manual.agents ?? []).filter((id) => poolMap.has(id) && !poolMap.get(id)!.locked).slice(0, max);
      planObj = ids.length
        ? { direct: false, planner: "manual", reason: "Agentes elegidos en modo manual.", steps: chainByClass(ids.map((agent, i) => ({ id: `s${i + 1}`, agent, task: "Resuelve la petición del usuario desde tu especialidad.", depends_on: [], why: defaultWhy(byId.get(agent)!, "Elegido por ti en modo manual") })), byId) }
        : { direct: true, steps: [], planner: "manual", reason: "Modo manual sin agentes: responde Kairo con el modelo elegido." };
    } else {
      const hist = historyText(c.history, 1200);
      planObj = (await planWithLLM({ env, userId: c.userId, plan, kind: "orchestrator" }, c.request, hist, poolMap, max, c.images.length > 0, c.project?.text ?? "")) ?? planWithRules(c.request, poolMap, max, c.images.length > 0);
    }
    planObj.task_type ??= classify(planObj.steps, byId);
    await emit(c, "PLAN_CREATED", {
      action: planObj.direct ? "Respuesta directa: no hacen falta agentes" : `Plan con ${planObj.steps.length} tarea(s)`,
      data: { planner: planObj.planner, task_type: planObj.task_type, reason: planObj.reason, steps: planObj.steps.map((s) => ({ id: s.id, agent: s.agent, depends_on: s.depends_on })) },
    });
    const rows = new Map<string, number>();
    for (const s of planObj.steps) {
      const waiting = s.depends_on.map((d) => byId.get(planObj.steps.find((x) => x.id === d)!.agent)!.name);
      const rowId = await run(
        env.DB,
        "INSERT INTO chat_run_agents (run_id, step, agent_id, task, depends_json, status, action, why, role) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?)",
        runId,
        s.id,
        s.agent,
        s.task,
        dumps(s.depends_on),
        waiting.length ? `Esperando a ${waiting.join(", ")}` : "En cola",
        s.why ?? defaultWhy(byId.get(s.agent)!),
        roleOf(byId.get(s.agent)!),
      );
      rows.set(s.id, rowId);
      await emit(c, "TASK_CREATED", { step: s.id, agent: s.agent, status: "QUEUED", action: s.task, data: { depends_on: s.depends_on } });
      if (waiting.length) await emit(c, "AGENT_WAITING", { step: s.id, agent: s.agent, status: "QUEUED", action: `Esperando a ${waiting.join(", ")}` });
    }
    await bump(env, runId, { status: planObj.direct ? "aggregating" : "running", task_type: planObj.task_type, plan_json: dumps({ ...planObj, manual: c.manual ?? undefined }) });

    // 3-4. EJECUTAR (paralelo + dependencias) Y COMBINAR RESULTADOS
    let final;
    if (planObj.direct) final = await direct(c);
    else {
      const results = await executePlan(c, planObj, byId, rows);
      await checkCancelled(c);
      await bump(env, runId, { status: "aggregating" });
      final = await aggregate(c, planObj, byId, results);
      const done = planObj.steps.filter((s) => results.get(s.id)?.status === "completed");
      if (done.length >= 2) {
        await checkCancelled(c);
        await bump(env, runId, { status: "validating" });
        final = await validate(c, final, done.map((s) => s.id));
      }
    }
    await checkCancelled(c);

    // 5. RESPUESTA FINAL
    const mid = await run(
      env.DB,
      "INSERT INTO chat_messages (thread_id, role, content, provider, model, fallback, notice, run_id, images_json, created_at) VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?)",
      runRow.thread_id,
      final.text,
      final.provider,
      final.model,
      final.fallback ? 1 : 0,
      c.notices.join(" · ") || null,
      runId,
      dumps(final.images),
      nowIso(),
    );
    await emit(c, "RUN_COMPLETED", { action: "Resultado entregado", data: { message_id: mid, images: final.images.length } });
    await bump(env, runId, { status: "completed", result_message_id: mid, notices_json: dumps(c.notices), finished_at: nowIso() });
    await run(env.DB, "UPDATE chat_threads SET updated_at = ? WHERE id = ?", nowIso(), runRow.thread_id);
    // Solo se notifica si tardó (el usuario puede haberse ido): evita spam.
    if (Date.now() - t0 > 20_000) {
      const link = runRow.project_id ? `#/p/${runRow.project_id}/workspace` : `#/chat/${runRow.thread_id}`;
      await notify(env, c.userId, { category: "ia", title: "Kairo terminó tu petición", body: c.request.slice(0, 120), link, dedupe: `chat-done-${runRow.thread_id}` });
    }
  } catch (err) {
    if (err instanceof Cancelled) {
      await emit(c, "RUN_CANCELLED", { action: "Cancelado por el usuario" });
      await bump(env, runId, { finished_at: nowIso(), notices_json: dumps(c.notices) });
      await run(env.DB, "UPDATE chat_run_agents SET status = 'ERROR', action = 'Cancelado' WHERE run_id = ? AND status NOT IN ('COMPLETED', 'ERROR')", runId);
      return;
    }
    const message = err instanceof RouterError ? err.message : `Error del orquestador: ${redact(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
    await emit(c, "RUN_FAILED", { action: message });
    await bump(env, runId, { status: "failed", error: message, notices_json: dumps(c.notices), finished_at: nowIso() });
    await notify(env, c.userId, { category: "ia", priority: "normal", title: "Kairo no pudo completar tu petición", body: message, link: `#/chat/${runRow.thread_id}`, dedupe: `chat-failed-${runRow.thread_id}` });
  }
}

/** Estado completo de una ejecución (lo que envía el stream SSE). */
export async function runState(db: D1Database, runId: number) {
  const r = await one<any>(db, "SELECT * FROM chat_runs WHERE id = ?", runId);
  if (!r) return null;
  const agents = await all<any>(db, "SELECT * FROM chat_run_agents WHERE run_id = ? ORDER BY id", runId);
  const events = await all<any>(db, "SELECT id, ts, ms, type, step, agent_id, status, action, progress FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 60", runId);
  const message = r.result_message_id ? await one<any>(db, "SELECT * FROM chat_messages WHERE id = ?", r.result_message_id) : null;
  const { plan_json, notices_json, ...rest } = r;
  const planObj = loads<any>(plan_json, {});
  return {
    run: { ...rest, notices: loads(notices_json, []), planner: planObj.planner ?? null, reason: planObj.reason ?? null, direct: Boolean(planObj.direct) },
    events: events.reverse(),
    agents: agents.map(({ depends_json, metadata_json, ...a }) => ({ ...a, depends_on: loads(depends_json, []), metadata: loads(metadata_json, {}), fallback: Boolean(a.fallback) })),
    message: message ? { ...message, images: loads(message.images_json, []), images_json: undefined } : null,
  };
}
