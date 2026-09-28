// AI ROUTER — único punto por el que los agentes y el chat llaman a un modelo.
//
//   Agente / Chat
//        ↓
//   AI Router ── ¿Claude disponible (Pro + créditos, o clave propia)? ── sí → Claude
//        │                                                              no ↓
//        └──────────────────────────────────────────→ Cloudflare Workers AI (gratis)
//
// - Nadie llama a Claude directamente: todo pasa por generate().
// - Si Claude falla por créditos, clave, límite o caída, se marca un
//   enfriamiento en D1 y se usa el respaldo. Al expirar, Claude vuelve a ser el
//   preferido sin tocar código (p. ej. después de recargar créditos).
// - Cada intento (bien o mal) se registra en usage_events con latencia,
//   tokens y coste estimado reales.

import Anthropic from "@anthropic-ai/sdk";
import { decryptJson, redact } from "../crypto";
import { nowIso, one, run } from "../db";
import type { Env } from "../env";
import { PLAN_LIMITS, type PlanId } from "../plans";

export type ProviderKind = "claude" | "claude-byok" | "workers-ai";

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  system: string;
  messages: ChatMsg[];
  maxTokens: number;
  /** premium = intentar Claude primero; free = modelos gratuitos primero. */
  prefer: "premium" | "free";
  /** Si no hay Claude, ¿se permite el modelo gratuito? */
  allowFallback: boolean;
  /** Usa CLAUDE_MODEL_ADVANCED en vez de CLAUDE_MODEL. */
  advanced?: boolean;
}

export interface CallContext {
  env: Env;
  userId: number;
  plan: PlanId;
  kind: "chat" | "agent" | "project";
  agentId?: string | null;
  agentRunId?: number | null;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  provider: ProviderKind;
  model: string;
  fallback: boolean;
  notices: string[];
  latencyMs: number;
}

export class RouterError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

// Precio público por millón de tokens (USD) para estimar coste. Modelos sin
// precio verificado cuentan 0 y se marcan como no estimados.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [0.293, 2.253],
};

const CLAUDE_HEALTH_KEY = "claude-platform";

interface Candidate {
  provider: ProviderKind;
  model: string;
  apiKey?: string;
}

async function healthy(db: D1Database, key: string): Promise<boolean> {
  const row = await one<any>(db, "SELECT available_after FROM provider_health WHERE provider = ?", key);
  return !row?.available_after || new Date(row.available_after).getTime() <= Date.now();
}

async function coolDown(db: D1Database, key: string, seconds: number, error: string) {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  await run(
    db,
    "INSERT INTO provider_health (provider, available_after, last_error, updated_at) VALUES (?, ?, ?, ?)" +
      " ON CONFLICT(provider) DO UPDATE SET available_after = excluded.available_after, last_error = excluded.last_error, updated_at = excluded.updated_at",
    key,
    until,
    redact(error).slice(0, 300),
    nowIso(),
  );
}

async function markHealthy(db: D1Database, key: string) {
  await run(db, "UPDATE provider_health SET available_after = NULL, updated_at = ? WHERE provider = ? AND available_after IS NOT NULL", nowIso(), key);
}

async function userClaudeKey(env: Env, userId: number): Promise<string> {
  const row = await one<any>(env.DB, "SELECT secret_enc FROM user_provider_keys WHERE user_id = ? AND provider = 'anthropic'", userId);
  return row ? (await decryptJson(env.ENCRYPTION_KEY, row.secret_enc)).api_key ?? "" : "";
}

/** Estado público de Claude para la UI (sin secretos). */
export async function claudeStatus(env: Env) {
  const configured = Boolean(env.ANTHROPIC_API_KEY);
  const row = await one<any>(env.DB, "SELECT available_after, last_error FROM provider_health WHERE provider = ?", CLAUDE_HEALTH_KEY);
  const cooling = row?.available_after && new Date(row.available_after).getTime() > Date.now();
  return {
    configured,
    available: configured && !cooling,
    retry_after: cooling ? row.available_after : null,
    last_error: cooling ? row.last_error : null,
    model: env.CLAUDE_MODEL,
    free_model: env.FREE_MODEL,
  };
}

async function candidates(ctx: CallContext, req: GenerateRequest, notices: string[]): Promise<Candidate[]> {
  const { env } = ctx;
  const claudeModel = req.advanced ? env.CLAUDE_MODEL_ADVANCED : env.CLAUDE_MODEL;
  const premium: Candidate[] = [];
  const byok = await userClaudeKey(env, ctx.userId);
  if (byok) premium.push({ provider: "claude-byok", model: claudeModel, apiKey: byok });
  if (PLAN_LIMITS[ctx.plan].claude && env.ANTHROPIC_API_KEY && (await healthy(env.DB, CLAUDE_HEALTH_KEY))) {
    premium.push({ provider: "claude", model: claudeModel, apiKey: env.ANTHROPIC_API_KEY });
  }
  const free: Candidate[] = [
    { provider: "workers-ai", model: env.FREE_MODEL },
    { provider: "workers-ai", model: env.FREE_MODEL_FALLBACK },
  ];
  if (req.prefer === "premium") {
    if (!premium.length) {
      if (!req.allowFallback) {
        throw new RouterError(
          "Modelo premium no disponible: esta tarea necesita Claude y ahora mismo no hay créditos o no tienes Control IA Pro.",
          "premium_unavailable",
        );
      }
      notices.push("Modelo premium no disponible · usando el modelo gratuito de respaldo");
    }
    return req.allowFallback ? [...premium, ...free] : premium;
  }
  // Preferencia gratuita: Claude solo como último recurso si el usuario tiene su propia clave.
  return [...free, ...premium.filter((c) => c.provider === "claude-byok")];
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

async function callClaude(ctx: CallContext, c: Candidate, req: GenerateRequest) {
  const client = new Anthropic({
    apiKey: c.apiKey,
    baseURL: ctx.env.ANTHROPIC_BASE_URL || undefined,
    timeout: 120_000,
    maxRetries: 1,
  });
  const msg = await client.messages.create(
    { model: c.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages },
    { signal: ctx.signal },
  );
  if (msg.stop_reason === "refusal") throw new RouterError("Claude declinó responder a esta petición.", "refusal");
  const text = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return { text, input: msg.usage.input_tokens, output: msg.usage.output_tokens, estimated: false };
}

async function callWorkersAI(ctx: CallContext, c: Candidate, req: GenerateRequest) {
  const { env } = ctx;
  const messages = [{ role: "system", content: req.system }, ...req.messages];
  if (env.AI_MODE === "mock") {
    // Solo en tests locales (AI_MODE=mock en .dev.vars). Respuesta determinista.
    const last = req.messages[req.messages.length - 1]?.content ?? "";
    if (last.includes("[forzar-error-gratis]")) throw new Error("Workers AI no disponible (simulado en test)");
    if (last.includes("[lento]")) await new Promise((r) => setTimeout(r, 1500));
    const text = `[modelo de prueba ${c.model}] ${last.slice(0, 400)}`;
    return { text, input: estimateTokens(JSON.stringify(messages)), output: estimateTokens(text), estimated: true };
  }
  if (!env.AI) throw new Error("El binding de Workers AI no está configurado.");
  const res: any = await env.AI.run(c.model as any, { messages, max_tokens: req.maxTokens } as any);
  const text =
    typeof res === "string" ? res
    : typeof res?.response === "string" ? res.response
    : res?.choices?.[0]?.message?.content ?? (res?.response ? JSON.stringify(res.response) : "");
  if (!text) throw new Error("Workers AI devolvió una respuesta vacía.");
  const u = res?.usage ?? {};
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  return input || output
    ? { text, input, output, estimated: false }
    : { text, input: estimateTokens(JSON.stringify(messages)), output: estimateTokens(text), estimated: true };
}

/** Clasifica un error de Claude y decide cuánto tiempo apartarlo. */
function claudeFailure(err: unknown): { message: string; cooldown: number } {
  const m = err instanceof Error ? err.message : String(err);
  const low = m.toLowerCase();
  if (low.includes("credit") || low.includes("billing") || low.includes("balance")) {
    return { message: "Claude sin créditos disponibles.", cooldown: 15 * 60 };
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { message: "La clave de Claude de la plataforma no es válida.", cooldown: 30 * 60 };
  }
  if (err instanceof Anthropic.RateLimitError) return { message: "Claude alcanzó su límite de uso.", cooldown: 60 };
  if (err instanceof Anthropic.NotFoundError) return { message: "El modelo de Claude configurado no existe.", cooldown: 30 * 60 };
  if (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500) return { message: "Claude no está disponible temporalmente.", cooldown: 30 };
  if (err instanceof Anthropic.APIConnectionError) return { message: "No se pudo conectar con Claude.", cooldown: 30 };
  return { message: `Error de Claude: ${redact(m).slice(0, 160)}`, cooldown: 0 };
}

async function recordUsage(ctx: CallContext, c: Candidate, fallback: boolean, ok: boolean, error: string | null, ms: number, u?: { input: number; output: number; estimated: boolean }) {
  const price = PRICES[c.model];
  const cost = price && u ? (u.input * price[0] + u.output * price[1]) / 1_000_000 : 0;
  await run(
    ctx.env.DB,
    "INSERT INTO usage_events (user_id, plan, kind, agent_id, agent_run_id, provider, model, fallback, ok, error, latency_ms, input_tokens, output_tokens, tokens_estimated, cost_usd, created_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ctx.userId,
    ctx.plan,
    ctx.kind,
    ctx.agentId ?? null,
    ctx.agentRunId ?? null,
    c.provider,
    c.model,
    fallback ? 1 : 0,
    ok ? 1 : 0,
    error ? redact(error).slice(0, 300) : null,
    ms,
    u?.input ?? 0,
    u?.output ?? 0,
    u?.estimated ? 1 : 0,
    Number(cost.toFixed(6)),
    nowIso(),
  );
}

export async function generate(ctx: CallContext, req: GenerateRequest): Promise<GenerateResult> {
  const notices: string[] = [];
  const list = await candidates(ctx, req, notices);
  if (!list.length) throw new RouterError("No hay ningún modelo disponible ahora mismo.", "no_models");
  let lastError = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const t0 = Date.now();
    try {
      const out = c.provider === "workers-ai" ? await callWorkersAI(ctx, c, req) : await callClaude(ctx, c, req);
      const ms = Date.now() - t0;
      // fallback = se usó un proveedor distinto del preferido.
      const fallback = notices.length > 0 || i > 0;
      await recordUsage(ctx, c, fallback, true, null, ms, out);
      if (c.provider === "claude") await markHealthy(ctx.env.DB, CLAUDE_HEALTH_KEY);
      return { text: out.text, provider: c.provider, model: c.model, fallback, notices, latencyMs: ms };
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      const ms = Date.now() - t0;
      const raw = err instanceof Error ? err.message : String(err);
      await recordUsage(ctx, c, i > 0, false, raw, ms);
      if (c.provider === "claude") {
        const f = claudeFailure(err);
        if (f.cooldown) await coolDown(ctx.env.DB, CLAUDE_HEALTH_KEY, f.cooldown, f.message);
        if (i + 1 < list.length) notices.push(`${f.message} · usando modelo de respaldo`);
        lastError = f.message;
      } else if (c.provider === "claude-byok") {
        const f = claudeFailure(err);
        if (i + 1 < list.length) notices.push(`Tu clave de Claude falló (${f.message}) · usando respaldo`);
        lastError = f.message;
      } else {
        if (i + 1 < list.length) notices.push(`${c.model} no respondió · probando otro modelo gratuito`);
        lastError = redact(raw).slice(0, 200);
      }
    }
  }
  throw new RouterError(`Ningún modelo pudo responder. Último error: ${lastError}`, "all_failed");
}

/** Generación de imagen con Workers AI (FLUX.1 schnell, Apache-2.0). Devuelve base64 JPEG. */
export async function generateImage(ctx: CallContext, prompt: string): Promise<{ b64: string; model: string }> {
  const { env } = ctx;
  const model = env.IMAGE_MODEL;
  const t0 = Date.now();
  const c: Candidate = { provider: "workers-ai", model };
  try {
    let b64: string;
    if (env.AI_MODE === "mock") {
      b64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
    } else {
      if (!env.AI) throw new Error("El binding de Workers AI no está configurado.");
      const res: any = await env.AI.run(model as any, { prompt: prompt.slice(0, 2000), steps: 4 } as any);
      b64 = res?.image;
      if (!b64) throw new Error("El modelo de imagen no devolvió ninguna imagen.");
    }
    await recordUsage(ctx, c, false, true, null, Date.now() - t0, { input: estimateTokens(prompt), output: 0, estimated: true });
    return { b64, model };
  } catch (err) {
    await recordUsage(ctx, c, false, false, err instanceof Error ? err.message : String(err), Date.now() - t0);
    throw new RouterError(`No se pudo generar la imagen: ${redact(err instanceof Error ? err.message : err).slice(0, 160)}`, "image_failed");
  }
}
