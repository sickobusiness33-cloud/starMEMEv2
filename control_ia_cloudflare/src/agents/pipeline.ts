// Ejecución de UNA etapa de un agente (llm o herramienta). La comparten el
// runtime del Agent Hub y el orquestador de Kairo, así ambos se comportan igual.

import { generate, type CallContext } from "../ai/router";
import { PLAN_LIMITS } from "../plans";
import { runAgentTool, type ToolContext } from "./tools";
import type { AgentManifest, AgentToolId, Stage } from "./types";

const EMPTY = "(sin trabajo previo)";

export function render(template: string, input: string, outputs: Record<string, string>): string {
  return template
    .replace(/\{\{input\}\}/g, input)
    .replace(/\{\{stage\.([a-z][a-z0-9_]*)\}\}/g, (_, id) => outputs[id]?.trim() || EMPTY);
}

export interface StageRequest {
  ctx: CallContext;
  agent: AgentManifest;
  /** Entrada que ve el agente (en el orquestador, ya filtrada y con la tarea asignada). */
  input: string;
  /** Texto literal del usuario: las URLs que puede leer web_read salen solo de aquí. */
  userInput: string;
  outputs: Record<string, string>;
  tools?: ToolContext;
  /** Modo manual: modelo forzado para las etapas llm. */
  model?: string;
  disabledTools?: Set<string>;
}

export interface StageResult {
  text: string;
  image?: { b64: string; id?: number; mime: string };
  provider?: string;
  model?: string;
  fallback?: boolean;
  notices: string[];
}

export function maxTokensFor(ctx: CallContext, agent: AgentManifest, stage?: number) {
  const cap = Math.min(PLAN_LIMITS[ctx.plan].maxOutputTokens, agent.limits?.maxOutputTokens ?? 4000);
  return Math.max(50, Math.min(stage ?? cap, cap));
}

export async function runStage(r: StageRequest, stage: Exclude<Stage, { kind: "agents" }>): Promise<StageResult> {
  const { ctx, agent } = r;
  if (stage.kind === "llm") {
    const res = await generate(ctx, {
      system: agent.instructions,
      messages: [{ role: "user", content: render(stage.prompt, r.input, r.outputs) }],
      maxTokens: maxTokensFor(ctx, agent, stage.maxTokens),
      prefer: agent.model.prefer,
      allowFallback: agent.model.allowFallback,
      advanced: agent.model.advanced,
      capability: agent.model.capability,
      model: r.model ?? agent.model.id,
    });
    return { text: res.text, provider: res.provider, model: res.model, fallback: res.fallback, notices: res.notices };
  }
  if (r.disabledTools?.has(stage.tool)) {
    return { text: `(herramienta «${stage.tool}» desactivada en modo manual)`, notices: [] };
  }
  const from = stage.from === "input" ? r.input : r.outputs[stage.from] ?? "";
  const res = await runAgentTool(ctx, stage.tool as AgentToolId, from, r.userInput, r.tools);
  return {
    text: res.text,
    image: res.image ? { b64: res.image, id: res.imageId, mime: res.mime ?? "image/jpeg" } : undefined,
    provider: res.provider,
    model: res.model,
    notices: [],
  };
}
