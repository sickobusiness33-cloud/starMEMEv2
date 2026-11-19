import { existsSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { join, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  QUANT_DISCLAIMER,
  type ArticleResponse,
  type FeedResponse,
  type KnownChainId,
  type MarketRegime,
  type QuantLeader,
  type QuantLeadersResponse,
  type QuantLibraryResponse,
  type RadarReport,
  type RadarStreamEvent,
  type Severity,
  type Stats,
  type StreamEvent,
} from '../../../shared/types.js';
import { engineState } from '../ai/claude.js';
import { CHAIN_CONFIGS } from '../chains/configs.js';
import type { AppConfig, TrustProxy } from '../config.js';
import { feedCursor, parseFeedCursor, type Db } from '../db/db.js';
import type { DistributionQueue } from '../distribution/queue.js';
import type { Bus } from '../engine/bus.js';
import { deriveMetrics } from '../engine/metrics.js';
import type { Scanner } from '../engine/scanner.js';
import { buildStats } from '../engine/stats.js';
import { errMsg, logger } from '../log.js';
import { computeLeaders } from '../quant/leaders.js';
import { METHODOLOGIES, SOURCE_POLICY } from '../quant/library.js';
import { createRegimeProvider } from '../quant/regime.js';
import { RadarBusyError, type RadarService } from '../research/radar.js';
import { isEventStream, openSse, sseFrame, SseHub, type SseStream } from './sse.js';

const log = logger('http');

const MINUTE_MS = 60_000;
const BODY_LIMIT_BYTES = 4 * 1024;
const ID_MAX_CHARS = 128;

const FEED_DEFAULT_LIMIT = 40;
const FEED_MAX_LIMIT = 100;
const DETECTIONS_DEFAULT_LIMIT = 50;
const DETECTIONS_MAX_LIMIT = 200;
/** detections scanned for an article's "related" list (newest first, later ones are filtered out) */
const RELATED_SCAN = 200;
const RELATED_LIMIT = 20;

const HELLO_ARTICLES = 40;
const HELLO_EVENTS = 60;
const STATS_PUSH_MS = 5_000;
/** shields the database from reconnect storms; the header refreshes every 5 s anyway */
const STATS_TTL_MS = 1_000;
/** the serialized hello frame is shared by every client connecting within this window (reconnect storms) */
const HELLO_TTL_MS = 1_000;

/**
 * Open event streams (newsroom + Radar). Each one holds a socket and up to its
 * pending-frame budget in memory, so they are capped per client and in total;
 * beyond a cap the request is answered 429 / 503 and EventSource retries later.
 */
const MAX_STREAMS_PER_CLIENT = 6;
const MAX_STREAMS_TOTAL = 1_000;
const MAX_RADAR_SUBSCRIBERS_PER_REPORT = 20;
const STREAM_RETRY_AFTER_SEC = 10;
/** a request (headers and body) must arrive within this; event streams are replies and are not affected */
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONNECTIONS = 4_000;

const LEADERS_TTL_MS = 15_000;
const LEADERS_WINDOW_MS = 120 * MINUTE_MS;
const LEADERS_UNIVERSE = 400;

const RADAR_QUERY_MAX_CHARS = 120;
const RADAR_RATE_LIMIT = 10;
const RADAR_RATE_WINDOW_MS = MINUTE_MS;
/** radar searches accepted per minute across all clients (address rotation cannot multiply the per-client limit) */
const RADAR_GLOBAL_RATE_LIMIT = 60;
/** a radar stream that never reaches a final state is closed; the client can still GET the report */
const RADAR_STREAM_MAX_MS = 10 * MINUTE_MS;

const LIBRARY_CACHE_CONTROL = 'public, max-age=300';
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // UI libraries (toasts, animated counters) inject their own <style> elements at runtime.
  "style-src 'self' 'unsafe-inline'",
  // token logos come from provider CDNs
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

export interface ServerDeps {
  config: AppConfig;
  db: Db;
  bus: Bus;
  scanner: Scanner;
  radar: RadarService;
  distribution: DistributionQueue;
  startedAt: number;
  /** built web app (directory holding index.html); null serves the API only */
  webDist: string | null;
  /**
   * Fastify `trustProxy` (see config.parseTrustProxy): a list of proxy addresses/CIDRs
   * or a hop-count function, never "trust every hop". Behind a reverse proxy it makes
   * `request.ip` (and so the rate limits) the client instead of the proxy. Default false.
   */
  trustProxy?: TrustProxy;
  /** the newsroom's shared market regime (articles cite the same one); default: computed here from storage */
  regime?: () => MarketRegime;
}

/** Shared state of one server instance, handed to the route groups. */
interface Ctx extends ServerDeps {
  stats: () => Stats;
  leaders: () => QuantLeadersResponse;
  live: LiveFeed;
  /** opens an SSE stream that is tracked for shutdown, or answers 429/503 (null) when a cap is reached */
  openStream: (request: FastifyRequest, reply: FastifyReply) => SseStream | null;
}

export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: deps.trustProxy ?? false,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });
  app.server.maxConnections = MAX_CONNECTIONS;

  const stats = cached(STATS_TTL_MS, (now) =>
    buildStats({
      db: deps.db,
      scanner: deps.scanner,
      engine: engineState(),
      distribution: deps.distribution,
      startedAt: deps.startedAt,
      now,
    }),
  );
  const live = new LiveFeed(deps.bus, stats);
  const streams = new Set<SseStream>();
  const perClient = new Map<string, number>();
  const openStream = (request: FastifyRequest, reply: FastifyReply): SseStream | null => {
    const client = clientKey(request.ip);
    if (streams.size >= MAX_STREAMS_TOTAL) {
      void reply
        .code(503)
        .header('retry-after', String(STREAM_RETRY_AFTER_SEC))
        .send({ error: 'unavailable', message: 'Too many open event streams, retry shortly' });
      return null;
    }
    if ((perClient.get(client) ?? 0) >= MAX_STREAMS_PER_CLIENT) {
      void reply
        .code(429)
        .header('retry-after', String(STREAM_RETRY_AFTER_SEC))
        .send({ error: 'rate_limited', message: 'Too many open event streams from this client' });
      return null;
    }
    const stream = openSse(reply);
    streams.add(stream);
    perClient.set(client, (perClient.get(client) ?? 0) + 1);
    stream.onClose(() => {
      streams.delete(stream);
      const left = (perClient.get(client) ?? 1) - 1;
      if (left <= 0) perClient.delete(client);
      else perClient.set(client, left);
    });
    return stream;
  };
  const regime =
    deps.regime ??
    createRegimeProvider((now, filters) => deps.db.regimeUniverse(now, filters), {
      maxTokenAgeHours: deps.config.scan.maxTokenAgeHours,
      onError: (e) => log.warn('regime computation failed', { error: errMsg(e) }),
    });
  const leaders = cached(LEADERS_TTL_MS, (now) => buildLeaders(deps.db, deps.config, regime(), now));
  const ctx: Ctx = { ...deps, stats, leaders, live, openStream };

  installHooks(app);
  // Open event streams would otherwise keep close() waiting forever; clients reconnect on their own.
  app.addHook('preClose', async () => {
    for (const s of [...streams]) s.abort();
  });
  app.addHook('onClose', async () => live.stop());

  registerNewsRoutes(app, ctx);
  registerRadarRoutes(app, ctx);
  registerQuantRoutes(app, ctx);
  const webEnabled = await registerWeb(app, deps.webDist);
  app.setNotFoundHandler(async (request, reply) => {
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (webEnabled && isRead && isSpaRoute(request.url)) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found', message: 'Not found' });
  });
  return app;
}

/* ───────────── hooks ───────────── */

function installHooks(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    if (isApiPath(request.url) && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    if (isEventStream(reply)) return;
    log.debug(`${request.method} ${request.url} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const status = errorStatus(error);
    if (status >= 500) log.error('request failed', { method: request.method, url: request.url, error: errMsg(error) });
    return reply.code(status).send({
      error: errorCode(status),
      message: status >= 500 ? 'Internal server error' : errMsg(error),
    });
  });
}

function errorStatus(error: unknown): number {
  const code = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' && code >= 400 && code <= 599 ? code : 500;
}

function errorCode(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 404:
      return 'not_found';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal_error' : 'request_error';
  }
}

/* ───────────── validation ───────────── */

const CHAIN_IDS = Object.keys(CHAIN_CONFIGS) as KnownChainId[];
const SEVERITIES = ['BREAKING', 'ALERT', 'WATCH'] as const satisfies readonly Severity[];

const limitParam = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);

/** Query objects treat `?before=` like an absent parameter. */
const queryObject = <T extends z.ZodRawShape>(shape: T) =>
  z.preprocess(
    (v) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '')) : v),
    z.object(shape),
  );

/** `before`: a createdAt (legacy) or the exact "<createdAt>:<id>" cursor of the previous page's last article */
const FeedCursorParam = z.string().transform((v, ctx) => {
  if (/^\d{1,16}$/.test(v) && Number(v) > 0) return Number(v);
  const cursor = parseFeedCursor(v);
  if (cursor) return cursor;
  ctx.addIssue({ code: 'custom', message: 'before must be a timestamp or a "<createdAt>:<id>" cursor' });
  return z.NEVER;
});

const FeedQuery = queryObject({
  limit: limitParam(FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT),
  before: FeedCursorParam.optional(),
  chain: z.enum(CHAIN_IDS).optional(),
  severity: z.enum(SEVERITIES).optional(),
});

const DetectionsQuery = queryObject({ limit: limitParam(DETECTIONS_DEFAULT_LIMIT, DETECTIONS_MAX_LIMIT) });

const IdParams = z.object({ id: z.string().min(1).max(ID_MAX_CHARS) });

/** The radar can only search chains that have a running adapter. */
function radarBody(chains: readonly string[]) {
  return z.object({
    query: z
      .string()
      .trim()
      .min(1, 'query must not be empty')
      .max(RADAR_QUERY_MAX_CHARS, `query must be at most ${RADAR_QUERY_MAX_CHARS} characters`),
    chain: z
      .string()
      .refine((c) => chains.includes(c), `chain must be one of: ${chains.join(', ')}`)
      .nullish()
      .transform((c) => c ?? undefined),
  });
}

/** Parses or answers 400; callers return `reply` when this yields null. */
function parseOr400<S extends z.ZodType>(schema: S, input: unknown, reply: FastifyReply): z.output<S> | null {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const message = parsed.error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
  void reply.code(400).send({ error: 'invalid_request', message });
  return null;
}

function notFound(reply: FastifyReply, what: string): FastifyReply {
  return reply.code(404).send({ error: 'not_found', message: `${what} not found` });
}

/* ───────────── newsroom ───────────── */

function registerNewsRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  app.get('/api/health', async () => ({ ok: true, uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000) }));

  app.get('/api/stats', async () => ctx.stats());

  app.get('/api/feed', async (request, reply) => {
    const q = parseOr400(FeedQuery, request.query, reply);
    if (!q) return reply;
    const articles = db.listArticles(q);
    const last = articles.at(-1);
    const more = articles.length === q.limit && last !== undefined;
    const body: FeedResponse = {
      articles,
      nextBefore: more ? last.createdAt : null,
      nextCursor: more ? feedCursor(last) : null,
    };
    return body;
  });

  app.get('/api/articles/:id', async (request, reply) => {
    const p = parseOr400(IdParams, request.params, reply);
    if (!p) return reply;
    const article = db.getArticle(p.id);
    if (!article) return notFound(reply, 'article');
    const related = db
      .detectionsFor(article.chain, article.address, RELATED_SCAN)
      .filter((e) => e.ts <= article.createdAt)
      .slice(0, RELATED_LIMIT);
    const body: ArticleResponse = { article, distribution: db.distributionFor(article.id), related };
    return body;
  });

  app.get('/api/detections', async (request, reply) => {
    const q = parseOr400(DetectionsQuery, request.query, reply);
    if (!q) return reply;
    return { events: db.recentDetections(q.limit) };
  });

  // one serialized hello for every client connecting within a second: a reconnect storm
  // (every client after a deploy) costs one database read, not one per client
  const helloFrame = cached(HELLO_TTL_MS, () => {
    const hello: StreamEvent = {
      type: 'hello',
      stats: ctx.stats(),
      articles: db.listArticles({ limit: HELLO_ARTICLES }),
      events: db.recentDetections(HELLO_EVENTS),
    };
    return sseFrame(hello.type, hello);
  });

  app.get('/api/stream', { exposeHeadRoute: false }, async (request, reply) => {
    // Built before the reply is hijacked so a database error is still a normal 500.
    const frame = helloFrame();
    const stream = ctx.openStream(request, reply);
    if (!stream) return reply;
    stream.sendFrame(frame);
    ctx.live.hub.add(stream);
    return reply;
  });
}

/**
 * Fans bus events out to every connected newsroom client. One bus subscription
 * and one stats computation per tick, however many clients are connected.
 */
class LiveFeed {
  readonly hub = new SseHub();
  private readonly unsubscribe: Array<() => void>;
  private readonly ticker: NodeJS.Timeout;

  constructor(
    bus: Bus,
    private readonly stats: () => Stats,
  ) {
    this.unsubscribe = [
      bus.on('article', (article) => this.push({ type: 'article', article })),
      bus.on('detection', (event) => this.push({ type: 'detection', event })),
    ];
    this.ticker = setInterval(() => this.pushStats(), STATS_PUSH_MS);
    this.ticker.unref();
  }

  stop(): void {
    clearInterval(this.ticker);
    for (const off of this.unsubscribe) off();
  }

  /** Bus listeners run inside the pipeline's emit; they must never throw back into it. */
  private push(event: StreamEvent, droppable = false): void {
    try {
      this.hub.broadcast(event.type, event, { droppable });
    } catch (e) {
      log.warn('stream broadcast failed', { type: event.type, error: errMsg(e) });
    }
  }

  private pushStats(): void {
    if (this.hub.size === 0) return;
    try {
      this.push({ type: 'stats', stats: this.stats() }, true);
    } catch (e) {
      log.warn('stats push failed', { error: errMsg(e) });
    }
  }
}

/* ───────────── radar ───────────── */

function registerRadarRoutes(app: FastifyInstance, ctx: Ctx): void {
  const limiter = new RateLimiter(RADAR_RATE_LIMIT, RADAR_RATE_WINDOW_MS);
  const global = new RateLimiter(RADAR_GLOBAL_RATE_LIMIT, RADAR_RATE_WINDOW_MS);
  const subscribers = new Map<string, number>();
  const body = radarBody(ctx.config.chains);

  app.post('/api/radar', async (request, reply) => {
    const input = parseOr400(body, request.body, reply);
    if (!input) return reply;
    const now = Date.now();
    const client = clientKey(request.ip);
    const perClient = limiter.check(client, now);
    const overall = global.check('*', now);
    const retryAfterSec = Math.max(perClient, overall);
    if (retryAfterSec > 0) {
      return reply
        .code(429)
        .header('retry-after', String(retryAfterSec))
        .send({ error: 'rate_limited', message: `Too many radar searches, retry in ${retryAfterSec} s` });
    }
    let report: RadarReport;
    try {
      report = ctx.radar.start(input.query, input.chain, { client });
    } catch (e) {
      if (!(e instanceof RadarBusyError)) throw e;
      return reply
        .code(503)
        .header('retry-after', String(e.retryAfterSec))
        .send({ error: 'unavailable', message: e.message });
    }
    limiter.record(client, now);
    global.record('*', now);
    return reply.code(202).send({ id: report.id });
  });

  app.get('/api/radar/:id', async (request, reply) => {
    const p = parseOr400(IdParams, request.params, reply);
    if (!p) return reply;
    return ctx.radar.get(p.id) ?? notFound(reply, 'radar report');
  });

  app.get('/api/radar/:id/stream', { exposeHeadRoute: false }, async (request, reply) => {
    const p = parseOr400(IdParams, request.params, reply);
    if (!p) return reply;
    const report = ctx.radar.get(p.id);
    if (!report) return notFound(reply, 'radar report');
    if (report.status === 'running' && (subscribers.get(report.id) ?? 0) >= MAX_RADAR_SUBSCRIBERS_PER_REPORT) {
      return reply
        .code(429)
        .header('retry-after', String(STREAM_RETRY_AFTER_SEC))
        .send({ error: 'rate_limited', message: 'Too many viewers on this radar report, retry shortly or GET it' });
    }
    const stream = ctx.openStream(request, reply);
    if (!stream) return reply;
    if (report.status === 'running') {
      subscribers.set(report.id, (subscribers.get(report.id) ?? 0) + 1);
      stream.onClose(() => {
        const left = (subscribers.get(report.id) ?? 1) - 1;
        if (left <= 0) subscribers.delete(report.id);
        else subscribers.set(report.id, left);
      });
    }
    followRadar(stream, report, ctx.radar);
    return reply;
  });
}

/**
 * One serialization per report change, however many viewers follow it: the radar
 * service hands every subscriber the same copy, so frames are cached by it.
 */
const radarFrames = new WeakMap<RadarReport, { report?: string; end?: string }>();

function radarFrame(event: RadarStreamEvent): string {
  const cache = radarFrames.get(event.report) ?? {};
  const hit = cache[event.type];
  if (hit !== undefined) return hit;
  const frame = sseFrame(event.type, event);
  cache[event.type] = frame;
  radarFrames.set(event.report, cache);
  return frame;
}

/** Streams a radar report: the current state now, every change after it, then `end` once it is final. */
function followRadar(stream: SseStream, initial: RadarReport, radar: RadarService): void {
  let lastFrame = '';
  const emit = (event: RadarStreamEvent): void => {
    const frame = radarFrame(event);
    if (frame === lastFrame) return; // subscribers may be handed the state they already have
    lastFrame = frame;
    stream.sendFrame(frame);
    if (event.type === 'end') stream.close();
  };
  const onReport = (report: RadarReport): void => {
    if (stream.closed) return;
    try {
      emit(report.status === 'running' ? { type: 'report', report } : { type: 'end', report });
    } catch (e) {
      log.warn('radar stream update failed', { id: report.id, error: errMsg(e) });
    }
  };

  emit({ type: 'report', report: initial });
  if (initial.status !== 'running') {
    emit({ type: 'end', report: initial });
    return;
  }
  const unsubscribe = radar.subscribe(initial.id, onReport);
  const deadline = setTimeout(() => stream.close(), RADAR_STREAM_MAX_MS);
  deadline.unref();
  stream.onClose(() => {
    clearTimeout(deadline);
    unsubscribe();
  });
}

/**
 * Sliding-window counter per key (client bucket, see clientKey). In memory: limits
 * reset on restart, which is acceptable for abuse protection of a single instance.
 */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit and returns 0, or returns the seconds to wait when the key is over its limit. */
  take(key: string, now: number): number {
    const wait = this.check(key, now);
    if (wait === 0) this.record(key, now);
    return wait;
  }

  /** 0 when the key may make a request now, else the seconds to wait. Records nothing. */
  check(key: string, now: number): number {
    this.sweep(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, recent);
    if (recent.length < this.limit) return 0;
    const oldest = recent[0] ?? now;
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  record(key: string, now: number): void {
    const recent = this.hits.get(key) ?? [];
    recent.push(now);
    this.hits.set(key, recent);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}

/* ───────────── quant ───────────── */

function registerQuantRoutes(app: FastifyInstance, ctx: Ctx): void {
  const library: QuantLibraryResponse = {
    methodologies: METHODOLOGIES,
    disclaimer: QUANT_DISCLAIMER,
    sourcePolicy: SOURCE_POLICY,
  };

  app.get('/api/quant/library', async (_request, reply) => {
    reply.header('cache-control', LIBRARY_CACHE_CONTROL);
    return library;
  });

  app.get('/api/quant/leaders', async () => ctx.leaders());
}

/**
 * Leaders over the latest observation of every token seen in the last 2 h that
 * clears the scanner's market minimums: a pool with $11 of liquidity "resembles"
 * every momentum methodology on a single trade, which says nothing.
 * Metrics are history-free (growth features stay null), which keeps this cheap.
 * The regime is the newsroom's shared one, the same that articles cite.
 */
function buildLeaders(db: Db, config: AppConfig, regime: MarketRegime, now: number): QuantLeadersResponse {
  const since = now - LEADERS_WINDOW_MS;
  const { minLiquidityUsd, minVolumeH1Usd } = config.scan;
  const snapshots = db.latestSnapshots(since, LEADERS_UNIVERSE, { minLiquidityUsd, minVolumeH1Usd });
  const entries = snapshots.map((snapshot) => ({
    snapshot,
    metrics: deriveMetrics(snapshot, [], now),
    articleId: null,
  }));
  return { regime, leaders: withArticleIds(db, computeLeaders(entries, regime)), computedAt: now };
}

/** Article links are looked up only for the few tokens that made a leaderboard. */
function withArticleIds(db: Db, leaders: QuantLeader[]): QuantLeader[] {
  const ids = new Map<string, string | null>();
  const articleId = (chain: string, address: string): string | null => {
    const key = `${chain}:${address}`;
    if (!ids.has(key)) ids.set(key, db.lastArticleFor(chain, address)?.id ?? null);
    return ids.get(key) ?? null;
  };
  return leaders.map((l) => ({
    ...l,
    tokens: l.tokens.map((t) => ({ ...t, articleId: articleId(t.chain, t.address) })),
  }));
}

/* ───────────── web app ───────────── */

/** Serves the built web app when there is one. Hashed files under /assets never change, so they are immutable. */
async function registerWeb(app: FastifyInstance, webDist: string | null): Promise<boolean> {
  if (!webDist) return false;
  const root = resolve(webDist);
  if (!existsSync(join(root, 'index.html'))) {
    log.warn('web build not found, serving the API only', { webDist: root });
    return false;
  }
  const assetsDir = join(root, 'assets') + sep;
  await app.register(fastifyStatic, {
    root,
    // Look files up per request: a web rebuild while the server runs must not leave the
    // fresh index.html pointing at hashed assets the server never learned about (blank app).
    // Missing files fall through to the not-found handler (SPA fallback / JSON 404).
    wildcard: true,
    cacheControl: false,
    setHeaders: (reply, path) => {
      reply.header('cache-control', path.startsWith(assetsDir) ? ASSET_CACHE_CONTROL : 'no-cache');
    },
  });
  return true;
}

function isApiPath(url: string): boolean {
  return url === '/api' || url.startsWith('/api/') || url.startsWith('/api?');
}

/**
 * Client-side routes get index.html. API paths, missing hashed assets and any
 * other path that looks like a file get a real 404 instead of HTML.
 */
function isSpaRoute(url: string): boolean {
  const path = url.split('?')[0] ?? '/';
  if (isApiPath(path) || path.startsWith('/assets/')) return false;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
}

/* ───────────── helpers ───────────── */

/**
 * The rate-limit identity of a client address: IPv4-mapped IPv6 is its IPv4
 * address, and IPv6 is bucketed by /64 (one subscriber's allocation), so rotating
 * addresses within a prefix does not buy a fresh limit.
 */
export function clientKey(ip: string): string {
  const addr = ip.trim().toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped?.[1]) return mapped[1];
  if (isIPv4(addr) || !isIPv6(addr)) return addr;
  const groups = expandIPv6(addr);
  if (!groups) return addr;
  // "::ffff:7f00:1" is the IPv4-mapped 127.0.0.1 written in hex
  if (groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff') {
    const [hi = 0, lo = 0] = [parseInt(groups[6] ?? '0', 16), parseInt(groups[7] ?? '0', 16)];
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** "2001:db8::1" → 8 four-digit groups; null when it is not a plain IPv6 address. */
function expandIPv6(addr: string): string[] | null {
  const [head = '', tail, extra] = addr.split('::');
  if (extra !== undefined) return null;
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  if (right.some((g) => g.includes('.')) || left.some((g) => g.includes('.'))) return null;
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array.from({ length: tail === undefined ? 0 : missing }, () => '0'), ...right];
  return groups.length === 8 ? groups.map((g) => g.padStart(4, '0')) : null;
}

function cached<T>(ttlMs: number, compute: (now: number) => T): () => T {
  let entry: { at: number; value: T } | null = null;
  return () => {
    const now = Date.now();
    if (!entry || now - entry.at >= ttlMs) entry = { at: now, value: compute(now) };
    return entry.value;
  };
}
