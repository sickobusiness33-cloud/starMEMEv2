// AGENT ADAPTER / RUNTIME — ejecuta un manifiesto de agente etapa a etapa.
//
//   Agente (manifiesto) → etapas → AI Router (llm) | herramienta permitida (tool) | subagentes (agents)
//
// - Los modelos se llaman SIEMPRE a través de generate() (AI Router).
// - Las herramientas son las de src/agents/tools.ts: sin acceso a secretos,
//   base de datos, sistema de archivos, cuentas ni wallets.
// - Multiagente: un agente maestro reparte el trabajo, los subagentes se
//   ejecutan en paralelo (profundidad 1) y una etapa final integra resultados.
// - El progreso (etapa actual, robots activos) se guarda en stages_json para
//   que la interfaz lo anime en tiempo real.

import { redact } from "../crypto";
import { dumps, loads, nowIso, one, update } from "../db";
import type { Env } from "../env";
import type { PlanId } from "../plans";
import { RouterError, type CallContext } from "../ai/router";
import { notify } from "../notify";
import { render, runStage } from "./pipeline";
import { getAgent, type RegistryAgent } from "./registry";
import type { AgentManifest, Stage } from "./types";


export interface SubProgress {
  id: string;
  name: string;
  color: string;
  status: "pending" | "running" | "completed" | "failed";
  stage?: string;
  provider?: string;
  model?: string;
}

export interface StageProgress {
  id: string;
  label: string;
  kind: Stage["kind"];
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  provider?: string;
  model?: string;
  fallback?: boolean;
  preview?: string;
  started_at?: string;
  finished_at?: string;
  agents?: SubProgress[];
}

class Cancelled extends Error {}

export function initialStages(agent: AgentManifest): StageProgress[] {
  return agent.stages.map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    status: "pending",
    ...(s.kind === "agents" ? { agents: [] } : {}),
  }));
}

interface Runner {
  env: Env;
  runId: number;
  userId: number;
  plan: PlanId;
  input: string;
  images: number[];
  notices: string[];
  stages: StageProgress[];
  save: () => Promise<void>;
  checkCancelled: () => Promise<void>;
}

function ctxFor(r: Runner, agentId: string): CallContext {
  return { env: r.env, userId: r.userId, plan: r.plan, kind: "agent", agentId, agentRunId: r.runId };
}

function note(r: Runner, list: string[]) {
  for (const n of list) if (!r.notices.includes(n)) r.notices.push(n);
}

function stage(r: Runner, agent: AgentManifest, s: Exclude<Stage, { kind: "agents" }>, input: string, outputs: Record<string, string>) {
  return runStage({ ctx: ctxFor(r, agent.id), agent, input, userInput: input, outputs, tools: { images: r.images } }, s).then((res) => {
    note(r, res.notices);
    return res;
  });
}

/** Ejecuta un subagente completo (sin subagentes propios) y devuelve su texto. */
async function runSub(r: Runner, sub: RegistryAgent, prompt: string, p: SubProgress): Promise<string> {
  const outputs: Record<string, string> = {};
  let last = "";
  p.status = "running";
  await r.save();
  for (const s of sub.stages) {
    await r.checkCancelled();
    p.stage = s.label;
    await r.save();
    if (s.kind === "agents") continue;
    if (s.kind === "tool" && s.tool.startsWith("image_")) {
      outputs[s.id] = "(la generación de imágenes no se usa dentro de un flujo multiagente)";
      continue;
    }
    const res = await stage(r, sub, s, prompt, outputs);
    outputs[s.id] = res.text;
    if (s.kind === "llm") {
      last = res.text;
      p.provider = res.provider;
      p.model = res.model;
    }
  }
  p.status = "completed";
  p.stage = undefined;
  await r.save();
  return last;
}

/** Ejecuta las etapas de un agente. Devuelve el resultado final. */
export async function executeAgent(r: Runner, agent: AgentManifest): Promise<{ output: string; kind: "text" | "image" }> {
  const outputs: Record<string, string> = {};
  let final: { output: string; kind: "text" | "image" } = { output: "", kind: "text" };
  for (let i = 0; i < agent.stages.length; i++) {
    await r.checkCancelled();
    const s = agent.stages[i];
    const sp = r.stages[i];
    sp.status = "running";
    sp.started_at = nowIso();
    await update(r.env.DB, "agent_runs", r.runId, { stage: s.id, stages_json: dumps(r.stages) });
    try {
      if (s.kind === "llm") {
        const res = await stage(r, agent, s, r.input, outputs);
        outputs[s.id] = res.text;
        Object.assign(sp, { provider: res.provider, model: res.model, fallback: res.fallback });
        final = { output: res.text, kind: "text" };
      } else if (s.kind === "tool") {
        const res = await stage(r, agent, s, r.input, outputs);
        outputs[s.id] = res.text;
        if (res.provider) Object.assign(sp, { provider: res.provider, model: res.model });
        if (res.image) final = { output: res.image.b64, kind: "image" };
      } else {
        const subs: RegistryAgent[] = [];
        for (const id of s.agents) {
          const a = await getAgent(r.env.DB, id);
          if (!a || a.stages.some((x) => x.kind === "agents")) throw new RouterError(`El subagente «${id}» no está disponible.`, "sub_missing");
          subs.push(a);
        }
        sp.agents = subs.map((a) => ({ id: a.id, name: a.name, color: a.color, status: "pending" as const }));
        const prompt = render(s.prompt, r.input, outputs);
        const results = await Promise.allSettled(subs.map((a, k) => runSub(r, a, prompt, sp.agents![k])));
        const parts: string[] = [];
        results.forEach((res, k) => {
          const a = subs[k];
          if (res.status === "fulfilled") parts.push(`### ${a.name}\n${res.value}`);
          else {
            sp.agents![k].status = "failed";
            if (res.reason instanceof Cancelled) throw res.reason;
            parts.push(`### ${a.name}\n(no pudo completar su parte: ${redact(res.reason?.message ?? res.reason).slice(0, 160)})`);
          }
        });
        if (results.every((x) => x.status === "rejected")) throw new RouterError("Ningún subagente pudo completar su parte.", "subs_failed");
        outputs[s.id] = parts.join("\n\n");
        final = { output: outputs[s.id], kind: "text" };
      }
      sp.status = "completed";
      sp.preview = final.kind === "image" && s.kind === "tool" ? "Imagen generada" : outputs[s.id]?.slice(0, 600);
      sp.finished_at = nowIso();
      await r.save();
    } catch (err) {
      sp.status = err instanceof Cancelled ? "cancelled" : "failed";
      sp.finished_at = nowIso();
      await r.save();
      throw err;
    }
  }
  return final;
}

/** Consumidor de la cola: procesa una ejecución de agente pendiente. */
export async function processAgentRun(env: Env, runId: number) {
  const row = await one<any>(env.DB, "SELECT * FROM agent_runs WHERE id = ?", runId);
  if (!row || row.status !== "pending") return;
  const agent = await getAgent(env.DB, row.agent_id);
  const stages = loads<StageProgress[]>(row.stages_json, []);
  const r: Runner = {
    env,
    runId,
    userId: row.user_id,
    plan: row.plan === "pro" ? "pro" : "free",
    input: row.input,
    images: loads<number[]>(row.images_json, []),
    notices: [],
    stages,
    save: async () => update(env.DB, "agent_runs", runId, { stages_json: dumps(stages), notices_json: dumps(r.notices) }),
    checkCancelled: async () => {
      const s = await one<any>(env.DB, "SELECT status FROM agent_runs WHERE id = ?", runId);
      if (s?.status === "cancelled") throw new Cancelled();
    },
  };
  if (!agent) {
    await update(env.DB, "agent_runs", runId, { status: "failed", error: "El agente ya no está disponible.", finished_at: nowIso() });
    return;
  }
  const claimed = await env.DB.prepare("UPDATE agent_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'")
    .bind(nowIso(), runId)
    .run();
  if (!claimed.meta.changes) return;
  try {
    const out = await executeAgent(r, agent);
    await env.DB.prepare(
      "UPDATE agent_runs SET status = 'completed', stage = 'completed', output = ?, output_kind = ?, stages_json = ?, notices_json = ?, finished_at = ? WHERE id = ? AND status = 'running'",
    )
      .bind(out.output, out.kind, dumps(stages), dumps(r.notices), nowIso(), runId)
      .run();
    await notify(env, r.userId, { category: "ia", title: `${agent.name} ha terminado`, body: row.input.slice(0, 120), link: `#/hub/run/${runId}`, dedupe: `agent-run-${runId}` });
  } catch (err) {
    if (err instanceof Cancelled) {
      await update(env.DB, "agent_runs", runId, { stages_json: dumps(stages), notices_json: dumps(r.notices), finished_at: nowIso() });
      return;
    }
    const msg = err instanceof RouterError ? err.message : `Error del agente: ${redact(err instanceof Error ? err.message : String(err)).slice(0, 240)}`;
    await env.DB.prepare(
      "UPDATE agent_runs SET status = 'failed', error = ?, stages_json = ?, notices_json = ?, finished_at = ? WHERE id = ? AND status = 'running'",
    )
      .bind(msg, dumps(stages), dumps(r.notices), nowIso(), runId)
      .run();
    await notify(env, r.userId, { category: "ia", title: `${agent.name} no pudo terminar`, body: msg, link: `#/hub/run/${runId}`, dedupe: `agent-run-${runId}` });
  }
}
