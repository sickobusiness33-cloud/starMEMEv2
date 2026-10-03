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
/** a request that waited this long for a limiter slot is stale for a real-time newsroom */
const DEFAULT_MAX_QUEUE_MS = 60_000;
/**
 * A 429 pauses the provider's whole limiter, not just the request that got it:
 * rate limits are per client, so every queued request would be refused as well.
 * Without a `retry-after` we wait long enough for a per-minute window to roll over.
 * Some providers (GeckoTerminal) answer 429 with `retry-after: 0`-ish values while
 * their window is still closed; honouring that literally produced a 429 every 2-3 s,
 * so the pause never drops below 15 s.
 */
const RATE_LIMIT_PAUSE_DEFAULT_MS = 20_000;
const RATE_LIMIT_PAUSE_MIN_MS = 15_000;
const RATE_LIMIT_PAUSE_MAX_MS = 60_000;

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
  /** per attempt, covers headers and body once a limiter slot is granted (default 8000) */
  timeoutMs?: number;
  /** extra attempts, only for 429 / 5xx / network errors (default 1) */
  retries?: number;
  headers?: Record<string, string>;
  /** key of a registered limiter */
  limiter?: string;
  /** cache successful responses by URL for this long */
  cacheTtlMs?: number;
  /**
   * Remember a 404 for this long: a repeated lookup of an address the provider does
   * not know costs one request instead of one per call (Radar queries can be random).
   */
  notFoundTtlMs?: number;
  /**
   * Fail fast (HttpError 429) instead of queueing when the limiter is paused after a
   * 429 for longer than this. For callers with their own short deadline, e.g. a
   * Radar intel provider, where waiting out the pause only ends in a timeout.
   */
  maxPauseWaitMs?: number;
  /**
   * Longest wait for a limiter slot (queue and 429 pause included) before the request
   * fails with RequestQueueError; default 60 s. The request timeout only starts once
   * a slot is granted, so this is what bounds a request's total time.
   */
  maxQueueMs?: number;
  /**
   * Caller cancellation: leaves the limiter queue (freeing the place for others) or
   * aborts the request in flight; the call rejects with RequestCancelledError.
   */
  signal?: AbortSignal;
}

/** The caller's AbortSignal fired; never retried. */
export class RequestCancelledError extends Error {
  override name = 'RequestCancelledError';
  constructor(readonly url: string) {
    super(`request cancelled (${describeUrl(url)})`);
  }
}

/**
 * The provider's local limiter could not grant a slot in time (queue full or wait
 * too long). The provider was never asked; never retried.
 */
export class RequestQueueError extends Error {
  override name = 'RequestQueueError';
  constructor(
    readonly url: string,
    readonly reason: 'full' | 'timeout',
  ) {
    const host = describeUrl(url).split('/')[0];
    super(reason === 'full' ? `${host} request queue full` : `${host} request queue wait timed out`);
  }
}

/* ───────────────────────────── Rate limiters ───────────────────────────── */

interface LimiterOpts {
  perMinute: number;
  /**
   * Requests that may start at once from a full bucket (default 10% of perMinute, at
   * least 1). The rest of the budget refills evenly, so a 60 s window still never
   * exceeds perMinute; a larger burst only front-loads it.
   */
  burst?: number;
  /** minimum gap between request starts; also makes requests run one at a time */
  minIntervalMs?: number;
  /** waiting requests beyond this are refused at once (RequestQueueError 'full'); default unbounded */
  maxQueue?: number;
  /**
   * Limiters that share the provider's per-client rate limit (e.g. the scanner's and
   * the Radar's GeckoTerminal lanes): a 429 on one pauses all of them. Default: the key.
   */
  group?: string;
}

type Release = () => void;

interface Waiter {
  grant: (release: Release) => void;
  fail: (e: Error) => void;
}

interface AcquireOpts {
  signal?: AbortSignal;
  /** reject with RequestQueueError('timeout') when no slot was granted within this long */
  maxWaitMs?: number;
  url: string;
}

/**
 * FIFO token bucket. The bucket holds a small burst (10% of the budget unless `burst`
 * says otherwise) and refills at the remaining rate, so no 60-second window can exceed
 * `perMinute` requests.
 * A waiting request leaves the queue when its caller gives up (abort signal or
 * maximum wait), so an abandoned request never costs a provider call.
 */
class Limiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly minIntervalMs: number;
  private tokens: number;
  private refilledAt: number;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private pausedUntil = 0;
  /** consecutive 429 answers; each one doubles the next pause, a success resets it */
  strikes = 0;
  private inFlight = 0;
  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly opts: LimiterOpts) {
    const perMinute = Math.max(1, opts.perMinute);
    this.capacity = Math.min(perMinute, Math.max(1, Math.floor(opts.burst ?? perMinute / 10)));
    this.refillPerMs = Math.max(1, perMinute - this.capacity) / 60_000;
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 0);
    this.tokens = this.capacity;
    this.refilledAt = Date.now();
  }

  get group(): string | undefined {
    return this.opts.group;
  }

  get queued(): number {
    return this.queue.length;
  }

  acquire(o: AcquireOpts): Promise<Release> {
    return new Promise((resolve, reject) => {
      if (o.signal?.aborted) {
        reject(new RequestCancelledError(o.url));
        return;
      }
      const max = this.opts.maxQueue;
      if (max !== undefined && this.queue.length >= max) {
        reject(new RequestQueueError(o.url, 'full'));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
      };
      const leave = (e: Error) => {
        const i = this.queue.indexOf(waiter);
        if (i < 0) return; // already granted
        this.queue.splice(i, 1);
        cleanup();
        reject(e);
      };
      const onAbort = () => leave(new RequestCancelledError(o.url));
      const waiter: Waiter = {
        grant: (release) => {
          cleanup();
          resolve(release);
        },
        fail: (e) => {
          cleanup();
          reject(e);
        },
      };
      this.queue.push(waiter);
      o.signal?.addEventListener('abort', onAbort, { once: true });
      if (o.maxWaitMs !== undefined && Number.isFinite(o.maxWaitMs)) {
        timer = setTimeout(() => leave(new RequestQueueError(o.url, 'timeout')), Math.max(0, o.maxWaitMs));
      }
      this.drain();
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  pausedUntilMs(): number {
    return this.pausedUntil;
  }

  /** Holds every queued and future request until `until` (a later pause wins). */
  pauseUntil(until: number): void {
    if (until <= this.pausedUntil) return;
    this.pausedUntil = until;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.drain();
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
      const waiter = this.queue.shift();
      if (!waiter) return;
      this.tokens -= 1;
      this.lastStartAt = now;
      this.inFlight += 1;
      waiter.grant(this.releaser());
    }
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.refilledAt) * this.refillPerMs);
    this.refilledAt = now;
  }

  private waitMs(now: number): number {
    const forToken = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
    const forInterval = this.lastStartAt + this.minIntervalMs - now;
    return Math.max(forToken, forInterval, this.pausedUntil - now, 0);
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

export function registerLimiter(key: string, opts: LimiterOpts): void {
  limiters.get(key)?.dispose();
  limiters.set(key, new Limiter(opts));
}

/**
 * Provider budgets. GeckoTerminal and DexScreener rate-limit per client across all
 * their endpoints, so interactive Radar searches get their own lane carved out of
 * the provider's budget (same group: a 429 pauses both lanes): however many searches
 * arrive, the scanner keeps its share and its queue never grows behind them.
 */
registerLimiter('geckoterminal', { perMinute: 20, maxQueue: 60, group: 'geckoterminal' });
// One Radar search asks GeckoTerminal for the token's top pool and its token info at the same
// time (the holders stage reuses both from the source cache): a burst of 3 lets a search get both
// at once. With a burst of 1 the second call waited 15 s for a slot and missed Radar's 10 s
// deadline on every search. Scanner 20 + Radar 6 stays under GeckoTerminal's 30 calls/min.
registerLimiter('geckoterminal-radar', { perMinute: 6, burst: 3, maxQueue: 12, group: 'geckoterminal' });
registerLimiter('dexscreener', { perMinute: 220, group: 'dexscreener' });
registerLimiter('dexscreener-radar', { perMinute: 30, maxQueue: 30, group: 'dexscreener' });
registerLimiter('dexscreener-meta', { perMinute: 55 });
registerLimiter('pumpfun', { perMinute: 30 });
registerLimiter('gdelt', { perMinute: 10, minIntervalMs: 5_500, maxQueue: 8 });
registerLimiter('hn', { perMinute: 60, maxQueue: 60 });
registerLimiter('biz', { perMinute: 30, minIntervalMs: 1_000, maxQueue: 30 });

/** Which share of a provider's budget a request draws from. */
export type Lane = 'scan' | 'radar';

/** What a caller of a provider module can ask of its requests. */
export interface CallOpts {
  /** 'radar' draws from the interactive lane of the provider's budget (default: the scanner's) */
  lane?: Lane;
  signal?: AbortSignal;
  maxQueueMs?: number;
  maxPauseWaitMs?: number;
}

/** The limiter key of a provider's lane: "geckoterminal" or "geckoterminal-radar". */
export function laneLimiter(provider: string, lane: Lane | undefined): string {
  return lane === 'radar' ? `${provider}-radar` : provider;
}

/** Waiting requests per limiter (diagnostics and tests). */
export function limiterQueueLength(key: string): number {
  return limiters.get(key)?.queued ?? 0;
}

/**
 * Pauses a provider's limiter (and every lane of the same provider) after it
 * answered 429; logs once per pause. Repeated 429s double the pause (20 s, 40 s,
 * 60 s cap) so a provider that keeps refusing this client is asked less and less often.
 */
function backOffLimiter(key: string | undefined, url: string, retryAfterMs: number | null): void {
  if (key === undefined) return;
  const limiter = limiters.get(key);
  if (!limiter) return;
  limiter.strikes += 1;
  const escalated = RATE_LIMIT_PAUSE_DEFAULT_MS * 2 ** Math.min(limiter.strikes - 1, 4);
  const pauseMs = Math.min(Math.max(retryAfterMs ?? escalated, RATE_LIMIT_PAUSE_MIN_MS), RATE_LIMIT_PAUSE_MAX_MS);
  const until = Date.now() + pauseMs;
  if (until <= limiter.pausedUntilMs()) return;
  for (const [k, l] of limiters) {
    if (k === key || (limiter.group !== undefined && l.group === limiter.group)) l.pauseUntil(until);
  }
  log.warn('rate limited, pausing provider', { limiter: limiter.group ?? key, url: describeUrl(url), pauseMs });
}

function acquire(
  key: string | undefined,
  url: string,
  o: { maxPauseWaitMs?: number; maxQueueMs?: number; signal?: AbortSignal },
): Promise<Release> {
  if (o.signal?.aborted) return Promise.reject(new RequestCancelledError(url));
  if (key === undefined) return Promise.resolve(() => {});
  const limiter = limiters.get(key);
  if (!limiter) return Promise.reject(new Error(`unknown rate limiter "${key}"`));
  const pausedFor = limiter.pausedUntilMs() - Date.now();
  if (o.maxPauseWaitMs !== undefined && pausedFor > o.maxPauseWaitMs) {
    const seconds = Math.ceil(pausedFor / 1000);
    return Promise.reject(
      new HttpError(429, url, `rate limited by ${describeUrl(url).split('/')[0]}, retrying in ${seconds}s`, pausedFor),
    );
  }
  return limiter.acquire({ url, signal: o.signal, maxWaitMs: o.maxQueueMs ?? DEFAULT_MAX_QUEUE_MS });
}

function clearStrikes(key: string | undefined): void {
  const limiter = key === undefined ? undefined : limiters.get(key);
  if (limiter) limiter.strikes = 0;
}

/* ───────────────────────────── TTL cache ───────────────────────────── */

const cache = new Map<string, { expiresAt: number; value: unknown }>();
/** 404 answers remembered per URL (`notFoundTtlMs`) */
const notFound = new Map<string, number>();

/**
 * A cached request in flight, shared by every caller asking for the same URL. It is
 * cancelled only when every caller that joined it has given up.
 */
interface Shared {
  promise: Promise<unknown>;
  controller: AbortController;
  /** callers still waiting for it; callers without a signal can never give up */
  waiting: number;
}
const inflight = new Map<string, Shared>();

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

function rememberNotFound(key: string, ttlMs: number): void {
  const now = Date.now();
  notFound.set(key, now + ttlMs);
  if (notFound.size <= CACHE_MAX_ENTRIES) return;
  for (const [k, until] of notFound) if (until <= now) notFound.delete(k);
  for (const k of notFound.keys()) {
    if (notFound.size <= CACHE_MAX_ENTRIES) break;
    notFound.delete(k);
  }
}

/** Test hook: clears the caches and resets every limiter to a full bucket. */
export function resetHttpState(): void {
  cache.clear();
  notFound.clear();
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
  const key = `${kind} ${url}`;
  const notFoundTtl = opts.notFoundTtlMs ?? 0;
  if (notFoundTtl > 0) {
    const until = notFound.get(key);
    if (until !== undefined && until > Date.now()) {
      return Promise.reject(new HttpError(404, url, `HTTP 404 from ${describeUrl(url)} (cached)`));
    }
  }
  const remember404 = <R>(p: Promise<R>): Promise<R> =>
    notFoundTtl > 0
      ? p.catch((e: unknown) => {
          if (e instanceof HttpError && e.status === 404) rememberNotFound(key, notFoundTtl);
          throw e;
        })
      : p;

  const ttl = opts.cacheTtlMs ?? 0;
  if (ttl <= 0) return remember404(fetchWithRetry(url, opts, parse, accept, opts.signal));

  const hit = cacheGet(key, Date.now());
  if (hit) return Promise.resolve(hit.value as T);
  let shared = inflight.get(key);
  if (!shared) {
    const controller = new AbortController();
    const promise = remember404(fetchWithRetry(url, opts, parse, accept, controller.signal))
      .then((value) => {
        cacheSet(key, value, ttl);
        return value;
      })
      .finally(() => {
        if (inflight.get(key) === entry) inflight.delete(key);
      });
    const entry: Shared = { promise, controller, waiting: 0 };
    shared = entry;
    inflight.set(key, entry);
  }
  return joinShared(shared, url, opts.signal) as Promise<T>;
}

/** One caller's view of a shared request: its own signal detaches it without cancelling the others. */
function joinShared(shared: Shared, url: string, signal: AbortSignal | undefined): Promise<unknown> {
  if (!signal) {
    shared.waiting = Number.POSITIVE_INFINITY;
    return shared.promise;
  }
  if (signal.aborted) return Promise.reject(new RequestCancelledError(url));
  shared.waiting += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      shared.waiting -= 1;
      if (shared.waiting <= 0) shared.controller.abort();
      reject(new RequestCancelledError(url));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

async function fetchWithRetry<T>(
  url: string,
  opts: FetchOpts,
  parse: BodyParser<T>,
  accept: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(url, opts, parse, accept, signal);
    } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      const delay = backoffMs(e, attempt);
      log.debug('retrying request', { url: describeUrl(url), attempt: attempt + 1, delayMs: delay, error: errMsg(e) });
      await sleep(delay, signal, url);
    }
  }
}

async function fetchOnce<T>(
  url: string,
  opts: FetchOpts,
  parse: BodyParser<T>,
  accept: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  const release = await acquire(opts.limiter, url, {
    maxPauseWaitMs: opts.maxPauseWaitMs,
    maxQueueMs: opts.maxQueueMs,
    signal,
  });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCancel = () => controller.abort();
  signal?.addEventListener('abort', onCancel, { once: true });
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept, ...opts.headers },
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), Date.now());
      if (res.status === 429) backOffLimiter(opts.limiter, url, retryAfter);
      throw new HttpError(res.status, url, `HTTP ${res.status} from ${describeUrl(url)}`, retryAfter);
    }
    clearStrikes(opts.limiter);
    return parse(body, url, res.status);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (signal?.aborted) throw new RequestCancelledError(url);
    const reason = controller.signal.aborted ? `timeout after ${timeoutMs}ms` : `network error: ${errMsg(e)}`;
    throw new HttpError(0, url, `${reason} (${describeUrl(url)})`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCancel);
    release();
  }
}

/** Only provider-side failures are retried; local refusals (cancelled, queue) never are. */
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

function sleep(ms: number, signal: AbortSignal | undefined, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestCancelledError(url));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RequestCancelledError(url));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
