/*
 * Outbound HTTP for every provider: timeouts, per-provider rate limiters,
 * one retry on transient failures and a small in-memory TTL cache.
 */
import { errMsg, logger } from '../log.js';

const log = logger('http');

const USER_AGENT = 'HootRadar/0.1 (+crypto intelligence newsroom)';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRIES = 1;
const BASE_BACKOFF_MS = 750;
const MAX_BACKOFF_MS = 10_000;
const CACHE_MAX_ENTRIES = 500;

export class HttpError extends Error {
  /** HTTP status; 0 when no response arrived (network failure or timeout). */
  readonly status: number;
  readonly url: string;
  /** server-requested delay before retrying (429 `retry-after`), when given */
  readonly retryAfterMs: number | null;

  constructor(status: number, url: string, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface FetchOpts {
  /** per attempt, covers headers and body (default 8000) */
  timeoutMs?: number;
  /** extra attempts, only for 429 / 5xx / network errors (default 1) */
  retries?: number;
  headers?: Record<string, string>;
  /** key of a registered limiter */
  limiter?: string;
  /** cache successful responses by URL for this long */
  cacheTtlMs?: number;
}

/* ───────────────────────────── Rate limiters ───────────────────────────── */

interface LimiterOpts {
  perMinute: number;
  /** minimum gap between request starts; also makes requests run one at a time */
  minIntervalMs?: number;
}

type Release = () => void;

/**
 * FIFO token bucket. Waiting requests are queued, never dropped.
 * The bucket holds a small burst (10% of the budget) and refills at the
 * remaining rate, so no 60-second window can exceed `perMinute` requests.
 */
class Limiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly minIntervalMs: number;
  private tokens: number;
  private refilledAt: number;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private inFlight = 0;
  private readonly queue: Array<(release: Release) => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly opts: LimiterOpts) {
    const perMinute = Math.max(1, opts.perMinute);
    this.capacity = Math.max(1, Math.floor(perMinute / 10));
    this.refillPerMs = Math.max(1, perMinute - this.capacity) / 60_000;
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 0);
    this.tokens = this.capacity;
    this.refilledAt = Date.now();
  }

  acquire(): Promise<Release> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private get serialized(): boolean {
    return this.minIntervalMs > 0;
  }

  private drain(): void {
    if (this.timer) return; // a wake-up is already scheduled
    while (this.queue.length > 0) {
      if (this.serialized && this.inFlight > 0) return; // release() drains again
      const now = Date.now();
      this.refill(now);
      const wait = this.waitMs(now);
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.drain();
        }, wait);
        return;
      }
      const grant = this.queue.shift();
      if (!grant) return;
      this.tokens -= 1;
      this.lastStartAt = now;
      this.inFlight += 1;
      grant(this.releaser());
    }
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.refilledAt) * this.refillPerMs);
    this.refilledAt = now;
  }

  private waitMs(now: number): number {
    const forToken = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
    const forInterval = this.lastStartAt + this.minIntervalMs - now;
    return Math.max(forToken, forInterval, 0);
  }

  private releaser(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.drain();
    };
  }
}

const limiters = new Map<string, Limiter>();

export function registerLimiter(key: string, opts: { perMinute: number; minIntervalMs?: number }): void {
  limiters.get(key)?.dispose();
  limiters.set(key, new Limiter(opts));
}

registerLimiter('geckoterminal', { perMinute: 25 });
registerLimiter('dexscreener', { perMinute: 250 });
registerLimiter('dexscreener-meta', { perMinute: 55 });
registerLimiter('pumpfun', { perMinute: 30 });
registerLimiter('gdelt', { perMinute: 10, minIntervalMs: 5_500 });
registerLimiter('hn', { perMinute: 60 });
registerLimiter('biz', { perMinute: 30, minIntervalMs: 1_000 });

function acquire(key: string | undefined): Promise<Release> {
  if (key === undefined) return Promise.resolve(() => {});
  const limiter = limiters.get(key);
  if (!limiter) return Promise.reject(new Error(`unknown rate limiter "${key}"`));
  return limiter.acquire();
}

/* ───────────────────────────── TTL cache ───────────────────────────── */

const cache = new Map<string, { expiresAt: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

function cacheGet(key: string, now: number): { value: unknown } | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt > now) return hit;
  cache.delete(key);
  return null;
}

function cacheSet(key: string, value: unknown, ttlMs: number): void {
  const now = Date.now();
  cache.delete(key); // re-insert so Map order tracks recency
  cache.set(key, { expiresAt: now + ttlMs, value });
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  for (const [k, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(k);
  }
  for (const k of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES) break;
    cache.delete(k);
  }
}

/** Test hook: clears the cache and resets every limiter to a full bucket. */
export function resetHttpState(): void {
  cache.clear();
  inflight.clear();
  for (const [key, limiter] of limiters) {
    limiter.dispose();
    limiters.set(key, new Limiter(limiter.opts));
  }
}

/* ───────────────────────────── Requests ───────────────────────────── */

type BodyParser<T> = (body: string, url: string, status: number) => T;

const parseJsonBody: BodyParser<unknown> = (body, url, status) => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(status, url, `invalid JSON from ${describeUrl(url)}`);
  }
};

const parseTextBody: BodyParser<string> = (body) => body;

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  return request(url, opts, 'json', parseJsonBody, 'application/json') as Promise<T>;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  return request(url, opts, 'text', parseTextBody, '*/*');
}

function request<T>(url: string, opts: FetchOpts, kind: string, parse: BodyParser<T>, accept: string): Promise<T> {
  const ttl = opts.cacheTtlMs ?? 0;
  if (ttl <= 0) return fetchWithRetry(url, opts, parse, accept);

  const key = `${kind} ${url}`;
  const hit = cacheGet(key, Date.now());
  if (hit) return Promise.resolve(hit.value as T);
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const p = fetchWithRetry(url, opts, parse, accept)
    .then((value) => {
      cacheSet(key, value, ttl);
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function fetchWithRetry<T>(url: string, opts: FetchOpts, parse: BodyParser<T>, accept: string): Promise<T> {
  const retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(url, opts, parse, accept);
    } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      const delay = backoffMs(e, attempt);
      log.debug('retrying request', { url: describeUrl(url), attempt: attempt + 1, delayMs: delay, error: errMsg(e) });
      await sleep(delay);
    }
  }
}

async function fetchOnce<T>(url: string, opts: FetchOpts, parse: BodyParser<T>, accept: string): Promise<T> {
  const release = await acquire(opts.limiter);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept, ...opts.headers },
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), Date.now());
      throw new HttpError(res.status, url, `HTTP ${res.status} from ${describeUrl(url)}`, retryAfter);
    }
    return parse(body, url, res.status);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const reason = controller.signal.aborted ? `timeout after ${timeoutMs}ms` : `network error: ${errMsg(e)}`;
    throw new HttpError(0, url, `${reason} (${describeUrl(url)})`);
  } finally {
    clearTimeout(timer);
    release();
  }
}

function isRetryable(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  return e.status === 0 || e.status === 429 || e.status >= 500;
}

function backoffMs(e: unknown, attempt: number): number {
  if (e instanceof HttpError && e.retryAfterMs !== null) return Math.min(e.retryAfterMs, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/** `retry-after` is either delay-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** host + path, without the query string, for log and error messages */
function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    const text = u.host + u.pathname;
    return text.length > 120 ? text.slice(0, 117) + '...' : text;
  } catch {
    return url.slice(0, 120);
  }
}
