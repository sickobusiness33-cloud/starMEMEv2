import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { EngineState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { errMsg, logger } from '../log.js';

const log = logger('claude');

type AiSettings = AppConfig['ai'];
export type Effort = AiSettings['effortNews'];

/** A configured client together with the settings every request needs. */
export interface ClaudeSession {
  client: Anthropic;
  ai: AiSettings;
}

/** Pinned so an ambient ANTHROPIC_BASE_URL (proxies, dev tooling) never redirects production traffic. */
const ANTHROPIC_API_URL = 'https://api.anthropic.com';

let session: ClaudeSession | null = null;
let status: EngineState['status'] = 'starting';
let aiError: string | null = null;

/**
 * Creates the Anthropic client only when an API key is configured. Key, auth
 * token and base URL are all explicit so ambient credentials or endpoints
 * (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL) never change who we talk to or as whom.
 */
export function initClaude(config: AppConfig): void {
  const { ai } = config;
  aiError = null;
  session = ai.apiKey ? { client: createClient(ai), ai } : null;
  log.info(session ? 'Claude enabled' : 'no ANTHROPIC_API_KEY, using the rules writer', {
    model: session ? ai.model : null,
  });
}

function createClient(ai: AiSettings): Anthropic {
  return new Anthropic({
    apiKey: ai.apiKey,
    authToken: null,
    baseURL: ANTHROPIC_API_URL,
    maxRetries: 1,
    timeout: ai.timeoutMs,
  });
}

export function claudeClient(): Anthropic | null {
  return session?.client ?? null;
}

export function claudeSession(): ClaudeSession | null {
  return session;
}

/**
 * `ai`/`model` describe the configured writer; `aiError` is set while the most
 * recent Claude call failed (its output was replaced by the rules writer).
 */
export function engineState(): EngineState {
  return {
    status,
    ai: session ? 'claude' : 'rules',
    model: session ? session.ai.model : null,
    aiError,
  };
}

/** Platform health is owned by the bootstrap/scanner; the AI layer only reports it. */
export function setEngineStatus(next: EngineState['status']): void {
  status = next;
}

export function reportAiError(e: unknown): void {
  aiError = describeAiError(e);
}

export function reportAiOk(): void {
  aiError = null;
}

/* ───────────── errors ───────────── */

/** Claude answered, but not with something we can publish (refusal, truncation, invalid JSON, style violation). */
export class AiOutputError extends Error {
  override name = 'AiOutputError';
}

/** The local concurrency queue is full; the caller should use its fallback without blaming the provider. */
export class QueueFullError extends Error {
  override name = 'QueueFullError';
}

/** The caller gave up while its call waited for a slot (or before it started); nothing was sent. */
export class CallCancelledError extends Error {
  override name = 'CallCancelledError';
}

const MAX_ERROR_CHARS = 200;

/**
 * Short, secret-free category for the header (`aiError`, public) and for Radar
 * statuses. Provider error messages are never included: they can carry billing or
 * organization details. Most specific SDK classes first.
 */
export function describeAiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Anthropic API key rejected (401)';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Anthropic API permission denied (403)';
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic API rate limit reached (429)';
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'Anthropic API request timed out';
  if (e instanceof Anthropic.APIUserAbortError) return 'Claude request cancelled';
  if (e instanceof Anthropic.APIConnectionError) return 'Anthropic API unreachable';
  if (e instanceof Anthropic.BadRequestError) return 'Anthropic API rejected the request (400)';
  if (e instanceof Anthropic.APIError) return `Anthropic API error${e.status ? ` ${e.status}` : ''}`;
  // our own validation messages (refusal, schema, guards) name no secret
  if (e instanceof AiOutputError) return redact(clip(`Claude output rejected: ${e.message}`, MAX_ERROR_CHARS));
  return 'Claude request failed';
}

/** The full (redacted) description, for the server log only. */
export function aiErrorDetail(e: unknown): string {
  const category = describeAiError(e);
  const detail = e instanceof AiOutputError ? '' : errMsg(e);
  return redact(clip(detail && detail !== category ? `${category}: ${detail}` : category, 2 * MAX_ERROR_CHARS));
}

function redact(s: string): string {
  return s.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[redacted]');
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/* ───────────── structured output ───────────── */

/**
 * JSON-schema output format derived from a zod schema. The SDK helper moves
 * constraints the API does not enforce (lengths, item counts) into field
 * descriptions; we still enforce them locally with zod after parsing.
 */
export function jsonOutputFormat(schema: z.ZodType): Anthropic.JSONOutputFormat {
  const json: Record<string, unknown> = { ...zodOutputFormat(schema).schema };
  if (typeof json.description === 'string' && json.description.startsWith('{$schema')) delete json.description;
  return { type: 'json_schema', schema: json };
}

export interface StructuredRequest<T> {
  /** static instructions; cached, so never put timestamps or per-request data here */
  system: string;
  user: string;
  format: Anthropic.JSONOutputFormat;
  schema: z.ZodType<T>;
  effort: Effort;
  maxTokens: number;
}

/** One structured-output call. Throws SDK errors or AiOutputError; callers decide on the fallback. */
export async function createStructured<T>(s: ClaudeSession, req: StructuredRequest<T>, signal?: AbortSignal): Promise<T> {
  const res = await s.client.messages.create(
    {
      model: s.ai.model,
      max_tokens: req.maxTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: req.user }],
      output_config: { effort: req.effort, format: req.format },
    },
    signal ? { timeout: s.ai.timeoutMs, signal } : { timeout: s.ai.timeoutMs },
  );
  return parseStructured(res, req.schema);
}

export function parseStructured<T>(res: Anthropic.Message, schema: z.ZodType<T>): T {
  if (res.stop_reason === 'refusal') {
    const category = res.stop_details?.category;
    throw new AiOutputError(`refusal${category ? ` (${category})` : ''}`);
  }
  if (res.stop_reason === 'max_tokens') throw new AiOutputError('truncated at max_tokens');

  const text = res.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  if (!text) throw new AiOutputError(`no text in response (stop_reason ${res.stop_reason ?? 'null'})`);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiOutputError('response is not valid JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new AiOutputError(`schema mismatch: ${issues}`);
  }
  return parsed.data;
}

/* ───────────── concurrency ───────────── */

/**
 * Caps in-flight Claude calls so a burst of detections cannot multiply cost.
 * Calls beyond `maxActive` wait in FIFO order; beyond `maxWaiting` they are
 * rejected with QueueFullError so real-time callers can fall back immediately
 * instead of publishing minutes late.
 */
export class CallLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxWaiting: number,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Runs `fn` once a slot is free. A caller whose `signal` fires while it waits
   * leaves the queue (its place goes to the next caller) and nothing is sent; a
   * signal that has already fired never starts the call.
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      if (signal?.aborted) throw new CallCancelledError('Claude call cancelled before it started');
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new CallCancelledError('Claude call cancelled before it started'));
    if (this.active < this.maxActive) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxWaiting) {
      return Promise.reject(new QueueFullError(`${this.waiting.length} Claude calls already queued`));
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new CallCancelledError('Claude call cancelled while queued'));
      };
      this.waiting.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Hands the slot straight to the next waiter so a new caller cannot overtake it. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}

/* ───────────── spend budget ───────────── */

/**
 * At most `limit` paid calls per sliding `windowMs`, across every caller that
 * shares the budget (e.g. all Radar visitors). `take` records one call when there
 * is room and says whether there was.
 */
export class CallBudget {
  private readonly at: number[] = [];

  constructor(
    readonly limit: number,
    private readonly windowMs: number,
  ) {}

  take(now: number): boolean {
    this.trim(now);
    if (this.at.length >= this.limit) return false;
    this.at.push(now);
    return true;
  }

  remaining(now: number): number {
    this.trim(now);
    return Math.max(0, this.limit - this.at.length);
  }

  private trim(now: number): void {
    while (this.at.length > 0 && now - (this.at[0] as number) >= this.windowMs) this.at.shift();
  }
}
