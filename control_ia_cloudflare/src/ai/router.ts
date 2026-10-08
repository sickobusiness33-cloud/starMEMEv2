// MODEL ROUTER — único punto por el que agentes, orquestador, chat e imágenes
// llaman a un modelo.
//
//   AI ORCHESTRATOR → MODEL ROUTER → ADAPTERS (workers-ai | anthropic | openai) → PROVEEDORES
//
// Orden de fuentes (configurable por usuario, tabla user_ai_settings):
//   modelo elegido (modo manual) → PLATFORM (Claude, solo Pro) → USER API → FREE (Workers AI)
// Con «USE MY API» activado, la API del usuario pasa a ser la primera.
// Si un modelo falla se prueba el siguiente de la cadena (fallback), y los
// fallos repetidos apartan ese modelo un tiempo (provider_health) para que la
// siguiente petición no pierda tiempo con él. Todo intento queda en usage_events.

import Anthropic from "@anthropic-ai/sdk";
import { redact } from "../crypto";
import { loads, nowIso, one, run } from "../db";
import type { Env } from "../env";
import { PLAN_LIMITS, type PlanId } from "../plans";
import { storedKey } from "../providers";
import { anthropicText } from "./adapters/anthropic";
import { openaiImage, openaiText } from "./adapters/openai";
import { hasImages, type ChatMsg, type ImageCall, type TextOut } from "./adapters/types";
import { workersImage, workersText } from "./adapters/workersai";
import { RouterError } from "./errors";
import { EXT_MODELS, FREE_CHAINS, MODEL_MAP, type Capability, type ModelInfo } from "./models";

export { RouterError };
export type { ChatMsg };

export type ProviderKind = "claude" | "claude-byok" | "openai-byok" | "gemini-byok" | "groq-byok" | "workers-ai";
/** IA preferida para una tarea (misión o proyecto). «auto» = orden normal con respaldo. */
export type AiPin = "auto" | "claude" | "openai" | "gemini" | "groq" | "cloudflare";
export const AI_PINS: AiPin[] = ["auto", "claude", "openai", "gemini", "groq", "cloudflare"];
const PIN_PROVIDERS: Record<Exclude<AiPin, "auto">, ProviderKind[]> = { claude: ["claude", "claude-byok"], openai: ["openai-byok"], gemini: ["gemini-byok"], groq: ["groq-byok"], cloudflare: ["workers-ai"] };
export type Source = "platform" | "user_api" | "free";
export const DEFAULT_PRIORITY: Source[] = ["platform", "user_api", "free"];

export interface GenerateRequest {
  system: string;
  messages: ChatMsg[];
  maxTokens: number;
  /** premium = intentar Claude/API primero; free = modelos gratuitos primero. */
  prefer: "premium" | "free";
  /** Si no hay premium, ¿se permite el modelo gratuito? */
  allowFallback: boolean;
  /** Usa CLAUDE_MODEL_ADVANCED en vez de CLAUDE_MODEL. */
  advanced?: boolean;
  /** Capacidad que necesita la tarea (elige la cadena gratuita adecuada). */
  capability?: Capability;
  /** Modelo concreto pedido (modo manual o manifiesto del agente). Va primero si está disponible. */
  model?: string;
  /** Tarea interna ligera (planificar, revisar): usa primero el modelo gratuito más barato. */
  cheap?: boolean;
  /** IA fijada para esta tarea: va primera; si falla, se sigue con las demás (nunca se queda parada). */
  pin?: AiPin | null;
}

export interface CallContext {
  env: Env;
  userId: number;
  plan: PlanId;
  kind: "chat" | "agent" | "project" | "orchestrator" | "image" | "autopilot" | "factory";
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

// Precio público por millón de tokens (USD) para estimar coste. Sin precio verificado = 0.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [0.293, 2.253],
};

const CLAUDE_HEALTH_KEY = "claude-platform";
const modelKey = (id: string) => `model:${id}`;

interface Candidate {
  provider: ProviderKind;
  model: ModelInfo;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  vendor?: "openai" | "gemini" | "groq";
}

// Claves propias que fallan por saldo o clave inválida se apartan un rato (no se pierde tiempo en cada llamada).
const byokKey = (userId: number, provider: string) => `byok:${userId}:${provider}`;
function byokFailure(raw: string): number {
  const low = raw.toLowerCase();
  if (/credit|billing|balance|insufficient|quota|exceeded your current|no credits/.test(low)) return 30 * 60;
  if (/\b401\b|\b403\b|invalid api key|api key not valid|unauthorized|permission/.test(low)) return 60 * 60;
  if (/\b429\b|rate limit|too many/.test(low)) return 60;
  return 0;
}
const extBase = (env: Env, vendor: "gemini" | "groq") =>
  (vendor === "gemini" ? env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai" : env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");

/** Gemini y Groq (claves gratuitas): se usan siempre que estén guardadas, sin necesidad de «Usar mi API». */
async function externalFree(env: Env, userId: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const vendor of ["gemini", "groq"] as const) {
    const key = await storedKey(env, userId, vendor);
    if (!key || !(await healthy(env.DB, byokKey(userId, `${vendor}-byok`)))) continue;
    for (const id of EXT_MODELS[vendor]) {
      const m = MODEL_MAP.get(id);
      if (m && (await healthy(env.DB, modelKey(`${vendor}:${userId}:${id}`)))) out.push({ provider: `${vendor}-byok`, model: m, modelId: id, apiKey: key, baseUrl: extBase(env, vendor), vendor });
    }
  }
  return out;
}

/** La IA fijada va primera (estable); las demás quedan detrás como respaldo. */
function applyPin(list: Candidate[], pin?: AiPin | null): Candidate[] {
  if (!pin || pin === "auto") return list;
  const want = PIN_PROVIDERS[pin] ?? [];
  return [...list.filter((c) => want.includes(c.provider)), ...list.filter((c) => !want.includes(c.provider))];
}

// --- salud de proveedores -----------------------------------------------------------

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

// --- ajustes del usuario ----------------------------------------------------------------

export interface AiSettings {
  use_my_api: boolean;
  priority: Source[];
}

export async function getAiSettings(db: D1Database, userId: number): Promise<AiSettings> {
  const row = await one<any>(db, "SELECT * FROM user_ai_settings WHERE user_id = ?", userId);
  const raw = loads<string[]>(row?.priority_json, DEFAULT_PRIORITY);
  const priority = [...new Set(raw.filter((s): s is Source => DEFAULT_PRIORITY.includes(s as Source)))];
  for (const s of DEFAULT_PRIORITY) if (!priority.includes(s)) priority.push(s);
  return { use_my_api: Boolean(row?.use_my_api), priority };
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

// --- cupo gratuito diario de Workers AI ---------------------------------------------------------
// El plan gratuito de Cloudflare da 10.000 «neuronas» al día (se renuevan a las 00:00 UTC).
// Al agotarse, Workers AI responde con el error 4006: se deja de intentar hasta la renovación.

const QUOTA_KEY = "workers-ai:daily-quota";
export const QUOTA_MESSAGE =
  "Se ha agotado el cupo gratuito diario de Cloudflare AI (se renueva a las 00:00 UTC, las 02:00 en España). " +
  "Para seguir ahora: conecta tu clave de Claude u OpenAI en el menú del chat (Conexiones de IA) o activa el plan Workers Paid de Cloudflare.";
export const isQuotaError = (m: string) => /\b4006\b|daily free allocation|neurons/i.test(m);
const secondsToUtcMidnight = () => {
  const d = new Date();
  return Math.max(60, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime()) / 1000) + 30);
};
export async function freeQuotaAvailable(db: D1Database): Promise<boolean> {
  return healthy(db, QUOTA_KEY);
}
async function markQuotaExhausted(db: D1Database, raw: string, mock = false) {
  // Pausa corta (30 min, o hasta la renovación si es antes) y se vuelve a probar: Cloudflare no siempre
  // renueva el cupo justo a las 00:00 UTC y un bloqueo hasta la medianoche siguiente paraba la fábrica un día entero.
  await coolDown(db, QUOTA_KEY, mock ? 3 : Math.min(30 * 60, secondsToUtcMidnight()), raw); // en tests (mock) solo 3 s
}

// --- cadena de candidatos ------------------------------------------------------------------

function claudeInfo(id: string): ModelInfo {
  return MODEL_MAP.get(id) ?? { id, label: id, adapter: "anthropic", kind: "text", capabilities: ["chat", "code", "reasoning", "vision"], license: "Servicio comercial", source: "platform" };
}

async function buildCandidates(ctx: CallContext, req: GenerateRequest, notices: string[]): Promise<Candidate[]> {
  const { env } = ctx;
  const settings = await getAiSettings(env.DB, ctx.userId);
  const capability: Capability = req.capability ?? (hasImages(req.messages) ? "vision" : "chat");
  const claudeId = req.advanced ? env.CLAUDE_MODEL_ADVANCED : env.CLAUDE_MODEL;

  const platform: Candidate[] = [];
  if (PLAN_LIMITS[ctx.plan].claude && env.ANTHROPIC_API_KEY && (await healthy(env.DB, CLAUDE_HEALTH_KEY))) {
    platform.push({ provider: "claude", model: claudeInfo(claudeId), modelId: claudeId, apiKey: env.ANTHROPIC_API_KEY });
  }
  // La API del usuario solo se usa con «USE MY API» activado; si no, configuración de la plataforma.
  const user: Candidate[] = [];
  // Con «Usar mi API» se usan siempre; si la tarea fija Claude u OpenAI, también (aunque esté apagado).
  const [anthropicKey, openaiKey] = await Promise.all([
    settings.use_my_api || req.pin === "claude" ? storedKey(env, ctx.userId, "anthropic") : "",
    settings.use_my_api || req.pin === "openai" ? storedKey(env, ctx.userId, "openai") : "",
  ]);
  const okUser = async (prov: string) => healthy(env.DB, byokKey(ctx.userId, prov));
  if (anthropicKey && (await okUser("claude-byok"))) user.push({ provider: "claude-byok", model: claudeInfo(claudeId), modelId: claudeId, apiKey: anthropicKey });
  if (openaiKey && (await okUser("openai-byok"))) {
    const m = MODEL_MAP.get("gpt-5-mini")!;
    user.push({ provider: "openai-byok", model: m, modelId: m.id, apiKey: openaiKey });
  }
  const ext = await externalFree(env, ctx.userId);
  const free: Candidate[] = [];
  const quotaOk = await freeQuotaAvailable(env.DB);
  const chain = req.cheap ? [env.FREE_MODEL_FALLBACK || "@cf/meta/llama-3.1-8b-instruct-fp8", ...(FREE_CHAINS[capability] ?? FREE_CHAINS.chat)] : FREE_CHAINS[capability] ?? FREE_CHAINS.chat;
  if (!quotaOk) {
    // Cupo gratis agotado: si el usuario tiene claves guardadas se usan como respaldo (aunque «Usar mi API» esté apagado).
    if (!user.length) {
      const [ak, ok] = await Promise.all([storedKey(env, ctx.userId, "anthropic"), storedKey(env, ctx.userId, "openai")]);
      if (ak && (await okUser("claude-byok"))) user.push({ provider: "claude-byok", model: claudeInfo(claudeId), modelId: claudeId, apiKey: ak });
      if (ok && (await okUser("openai-byok"))) { const m = MODEL_MAP.get("gpt-5-mini")!; user.push({ provider: "openai-byok", model: m, modelId: m.id, apiKey: ok }); }
      if (user.length) notices.push("Cupo gratuito de Cloudflare AI agotado por hoy · usando tu API");
    }
    const list = [...platform, ...user, ...ext];
    if (!list.length) throw new RouterError(QUOTA_MESSAGE, "free_quota");
    return applyPin(list, req.pin);
  }
  for (const id of [...chain, ...FREE_CHAINS.chat]) {
    const m = MODEL_MAP.get(id);
    if (m && !free.some((c) => c.modelId === id) && (await healthy(env.DB, modelKey(id)))) free.push({ provider: "workers-ai", model: m, modelId: id });
  }
  if (!free.length) {
    // Si todo está en enfriamiento se vuelve a intentar el modelo principal.
    const m = MODEL_MAP.get(env.FREE_MODEL) ?? MODEL_MAP.get(chain[0])!;
    free.push({ provider: "workers-ai", model: m, modelId: m.id });
  }

  // Orden de fuentes: el del usuario; «USE MY API» adelanta su API.
  // Orden de fuentes configurable por el usuario (por defecto: plataforma → su API → gratis).
  const order: Source[] = settings.priority;
  const bySource: Record<Source, Candidate[]> = { platform, user_api: user, free: [...ext, ...free] };
  const premiumSources = order.filter((s) => s !== "free");
  const premium = premiumSources.flatMap((s) => bySource[s]);

  let list: Candidate[];
  if (req.prefer === "premium") {
    if (!premium.length) {
      if (!req.allowFallback) {
        throw new RouterError(
          "Modelo premium no disponible: esta tarea necesita Claude y ahora mismo no hay créditos, no tienes Control IA Pro o no has añadido tu propia API.",
          "premium_unavailable",
        );
      }
      // Solo se avisa si el usuario esperaba premium (Pro o su API activada), no en cada respuesta del plan gratuito.
      if (PLAN_LIMITS[ctx.plan].claude || settings.use_my_api) {
        const saved = !settings.use_my_api && (await storedKey(env, ctx.userId, "anthropic"));
        notices.push(saved
          ? "Modelo premium no disponible · tienes tu clave de Claude guardada: activa «Usar mi API» en Ajustes para usarla"
          : "Modelo premium no disponible · usando el modelo gratuito de respaldo");
      }
    }
    // Se respeta el orden configurado por el usuario (si pone «gratis» primero, va primero).
    list = req.allowFallback ? order.flatMap((s) => bySource[s]) : premium;
  } else {
    // La tarea prefiere modelos gratuitos: gratis primero, salvo que el usuario ponga su API delante.
    list = order.indexOf("user_api") < order.indexOf("free") ? [...user, ...ext, ...free] : [...ext, ...free, ...user];
  }
  list = applyPin(list, req.pin);

  // Modelo pedido explícitamente (modo manual / manifiesto): primero, si es accesible.
  if (req.model) {
    const idx = list.findIndex((c) => c.modelId === req.model || (req.model!.startsWith("claude") && c.model.adapter === "anthropic"));
    if (idx > 0) list.unshift(...list.splice(idx, 1));
    else if (idx < 0) {
      const m = MODEL_MAP.get(req.model);
      if (m?.adapter === "workers-ai" && m.kind === "text") list.unshift({ provider: "workers-ai", model: m, modelId: m.id });
      else if (m) notices.push(`${m.label} no está disponible para tu cuenta · se usa otro modelo`);
    }
  }
  // Sin visión en el candidato: se le pasa solo el texto (el adapter lo gestiona).
  return list;
}

// --- llamadas ------------------------------------------------------------------------------

async function callText(ctx: CallContext, c: Candidate, req: GenerateRequest): Promise<TextOut> {
  const call = { env: ctx.env, model: c.model, modelId: c.modelId, system: req.system, messages: req.messages, maxTokens: req.maxTokens, apiKey: c.apiKey, signal: ctx.signal, baseUrl: c.baseUrl, vendor: c.vendor };
  if (c.model.adapter === "anthropic") return anthropicText(call);
  if (c.model.adapter === "openai") return openaiText(call);
  return workersText(call);
}

/** Clasifica un error de Claude y decide cuánto tiempo apartarlo. */
function claudeFailure(err: unknown): { message: string; cooldown: number } {
  const m = err instanceof Error ? err.message : String(err);
  const low = m.toLowerCase();
  if (low.includes("credit") || low.includes("billing") || low.includes("balance")) return { message: "Claude sin créditos disponibles.", cooldown: 15 * 60 };
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { message: "La clave de Claude no es válida.", cooldown: 30 * 60 };
  if (err instanceof Anthropic.RateLimitError) return { message: "Claude alcanzó su límite de uso.", cooldown: 60 };
  if (err instanceof Anthropic.NotFoundError) return { message: "El modelo de Claude configurado no existe.", cooldown: 30 * 60 };
  if (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500) return { message: "Claude no está disponible temporalmente.", cooldown: 30 };
  if (err instanceof Anthropic.APIConnectionError) return { message: "No se pudo conectar con Claude.", cooldown: 30 };
  return { message: `Error de Claude: ${redact(m).slice(0, 160)}`, cooldown: 0 };
}

/** Errores de un modelo gratuito que indican que no merece la pena reintentarlo enseguida. */
function freeCooldown(message: string): number {
  const low = message.toLowerCase();
  if (low.includes("not found") || low.includes("no such model") || low.includes("invalid model") || low.includes("unknown model")) return 30 * 60;
  if (low.includes("capacity") || low.includes("overloaded") || low.includes("429") || low.includes("rate")) return 60;
  if (low.includes("simulado")) return 0; // tests
  // Petición demasiado larga para ESTE modelo: no es culpa del modelo, no se aparta para los demás.
  if (low.includes("context window") || low.includes("5021")) return 0;
  return 20;
}

async function recordUsage(
  ctx: CallContext,
  provider: string,
  model: string,
  fallback: boolean,
  ok: boolean,
  error: string | null,
  ms: number,
  u?: { input: number; output: number; estimated: boolean },
) {
  const price = PRICES[model];
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
    provider,
    model,
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
  const list = await buildCandidates(ctx, req, notices);
  if (!list.length) throw new RouterError("No hay ningún modelo disponible ahora mismo.", "no_models");
  let lastError = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const t0 = Date.now();
    try {
      const out = await callText(ctx, c, req);
      if (!out.text.trim()) throw new Error("respuesta vacía");
      const ms = Date.now() - t0;
      const fallback = notices.some((n) => n.startsWith("Modelo premium")) || i > 0;
      await recordUsage(ctx, c.provider, c.modelId, fallback, true, null, ms, out);
      if (c.provider === "claude") await markHealthy(ctx.env.DB, CLAUDE_HEALTH_KEY);
      return { text: out.text, provider: c.provider, model: c.modelId, fallback, notices, latencyMs: ms };
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      const ms = Date.now() - t0;
      const raw = err instanceof Error ? err.message : String(err);
      await recordUsage(ctx, c.provider, c.modelId, i > 0, false, raw, ms);
      const more = i + 1 < list.length;
      const ext = c.provider === "gemini-byok" || c.provider === "groq-byok";
      if (c.provider === "claude-byok" || c.provider === "openai-byok") {
        const cd = byokFailure(raw);
        if (cd) await coolDown(ctx.env.DB, byokKey(ctx.userId, c.provider), cd, raw);
      }
      if (ext) {
        // Gemini/Groq: el cupo gratis y la saturación son POR MODELO → se aparta solo ese modelo y se prueba el siguiente.
        // Solo una clave inválida aparta todo el proveedor.
        const mk = modelKey(`${c.vendor}:${ctx.userId}:${c.modelId}`);
        if (/\b404\b|not found|no longer available|does not exist|decommissioned/i.test(raw)) await coolDown(ctx.env.DB, mk, 6 * 3600, raw);
        else if (/\b429\b|quota|rate limit|too many|resource_exhausted/i.test(raw)) await coolDown(ctx.env.DB, mk, /quota|resource_exhausted/i.test(raw) ? 20 * 60 : 60, raw);
        else if (/\b50[03]\b|high demand|overloaded|unavailable/i.test(raw)) await coolDown(ctx.env.DB, mk, 120, raw);
        else if (/\b401\b|\b403\b|api key not valid|invalid api key|unauthorized|permission/i.test(raw)) {
          await coolDown(ctx.env.DB, byokKey(ctx.userId, c.provider), 60 * 60, raw);
          list.splice(i + 1, list.length, ...list.slice(i + 1).filter((x) => x.provider !== c.provider));
        }
        if (more) notices.push(`${c.vendor === "gemini" ? "Gemini" : "Groq"} no respondió · probando otra IA`);
        lastError = redact(raw).slice(0, 200);
      } else if (c.provider === "claude" || c.provider === "claude-byok") {
        const f = claudeFailure(err);
        if (c.provider === "claude" && f.cooldown) await coolDown(ctx.env.DB, CLAUDE_HEALTH_KEY, f.cooldown, f.message);
        if (more) notices.push(c.provider === "claude" ? `${f.message} · usando modelo de respaldo` : `Tu clave de Claude falló (${f.message}) · usando respaldo`);
        lastError = f.message;
      } else if (c.provider === "openai-byok") {
        if (more) notices.push(`Tu API de OpenAI falló · usando respaldo`);
        lastError = redact(raw).slice(0, 200);
      } else if (isQuotaError(raw)) {
        // Cupo diario agotado: ningún otro modelo de Workers AI responderá hasta mañana.
        await markQuotaExhausted(ctx.env.DB, raw, ctx.env.AI_MODE === "mock");
        const rest = list.slice(i + 1).filter((x) => x.provider !== "workers-ai");
        if (!rest.length) throw new RouterError(QUOTA_MESSAGE, "free_quota");
        list.splice(i + 1, list.length, ...rest);
        notices.push("Cupo gratuito de Cloudflare AI agotado por hoy · usando tu API");
        lastError = "cupo gratuito agotado";
      } else {
        const cd = freeCooldown(raw);
        if (cd) await coolDown(ctx.env.DB, modelKey(c.modelId), cd, raw);
        if (more) notices.push(`${c.model.label} no respondió · probando otro modelo`);
        lastError = redact(raw).slice(0, 200);
      }
    }
  }
  throw new RouterError(`Ningún modelo pudo responder. Último error: ${lastError}`, "all_failed");
}

// --- imágenes --------------------------------------------------------------------------------

export interface ImageRequest {
  mode: ImageCall["mode"];
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  seed?: number;
  strength?: number;
  image?: Uint8Array;
  mask?: Uint8Array;
  /** "auto" o id del catálogo. */
  model?: string;
}

export interface ImageResult {
  bytes: Uint8Array;
  mime: string;
  model: string;
  fallback: boolean;
  notices: string[];
  latencyMs: number;
}

const MODE_CAP: Record<ImageCall["mode"], Capability> = { t2i: "t2i", i2i: "i2i", variation: "i2i", inpaint: "inpaint" };

export async function routeImage(ctx: CallContext, req: ImageRequest): Promise<ImageResult> {
  const { env } = ctx;
  const cap = MODE_CAP[req.mode];
  const settings = await getAiSettings(env.DB, ctx.userId);
  const openaiKey = settings.use_my_api ? await storedKey(env, ctx.userId, "openai") : "";
  const chain: { model: ModelInfo; apiKey?: string }[] = [];
  const push = (id: string, apiKey?: string) => {
    const m = MODEL_MAP.get(id);
    if (m && m.capabilities.includes(cap) && !chain.some((c) => c.model.id === id)) chain.push({ model: m, apiKey });
  };
  const notices: string[] = [];
  if (req.model && req.model !== "auto") {
    const m = MODEL_MAP.get(req.model);
    if (!m || m.kind !== "image") throw new RouterError("Ese modelo de imagen no existe.", "bad_model");
    if (!m.capabilities.includes(cap)) notices.push(`${m.label} no admite este modo · se usa otro modelo compatible`);
    else if (m.source === "user" && !openaiKey) notices.push(`${m.label} necesita tu API de OpenAI con «Usar mi API» activado · se usa un modelo gratuito`);
    else push(m.id, m.source === "user" ? openaiKey : undefined);
  }
  if (openaiKey && settings.priority.indexOf("user_api") < settings.priority.indexOf("free")) push("gpt-image-1", openaiKey);
  const quotaOk = await freeQuotaAvailable(env.DB);
  if (!quotaOk && !openaiKey) {
    const ok = await storedKey(env, ctx.userId, "openai");
    if (ok) { push("gpt-image-1", ok); notices.push("Cupo gratuito de Cloudflare AI agotado por hoy · usando tu API de OpenAI"); }
  }
  if (quotaOk) {
    for (const id of FREE_CHAINS[cap]) if (await healthy(env.DB, modelKey(id))) push(id);
    if (!chain.length) for (const id of FREE_CHAINS[cap]) push(id);
  }
  if (!chain.length && !quotaOk) throw new RouterError(QUOTA_MESSAGE, "free_quota");
  if (!chain.length) {
    if (cap === "inpaint") throw new RouterError("El inpainting necesita tu API de OpenAI con «Usar mi API» activado (no hay un modelo gratuito disponible).", "needs_user_api");
    throw new RouterError("No hay ningún modelo que admita esta operación.", "no_models");
  }

  let lastError = "";
  for (let i = 0; i < chain.length; i++) {
    const { model, apiKey } = chain[i];
    const t0 = Date.now();
    const provider = model.adapter === "openai" ? "openai-byok" : "workers-ai";
    try {
      const call: ImageCall = { env, model, mode: req.mode, prompt: req.prompt, negative: req.negative, width: req.width, height: req.height, seed: req.seed, strength: req.strength, image: req.image, mask: req.mask, apiKey };
      const out = model.adapter === "openai" ? await openaiImage(call) : await workersImage(call);
      const ms = Date.now() - t0;
      await recordUsage(ctx, provider, model.id, i > 0, true, null, ms, { input: Math.ceil(req.prompt.length / 4), output: 0, estimated: true });
      return { ...out, model: model.id, fallback: i > 0, notices, latencyMs: ms };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      await recordUsage(ctx, provider, model.id, i > 0, false, raw, Date.now() - t0);
      if (provider === "workers-ai" && isQuotaError(raw)) {
        await markQuotaExhausted(env.DB, raw, env.AI_MODE === "mock");
        if (!chain.slice(i + 1).some((c) => c.model.adapter === "openai")) throw new RouterError(QUOTA_MESSAGE, "free_quota");
      } else if (provider === "workers-ai") {
        const cd = freeCooldown(raw);
        if (cd) await coolDown(env.DB, modelKey(model.id), cd, raw);
      }
      if (i + 1 < chain.length) notices.push(`${model.label} no respondió · probando ${chain[i + 1].model.label}`);
      lastError = redact(raw).slice(0, 200);
    }
  }
  throw new RouterError(`No se pudo generar la imagen. Último error: ${lastError}`, "image_failed");
}
