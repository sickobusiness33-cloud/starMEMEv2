import { EventEmitter } from 'node:events';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUANT_DISCLAIMER,
  type ChainId,
  type ChainInfo,
  type DetectionEvent,
  type MarketRegime,
  type NewsArticle,
  type RadarReport,
  type Severity,
  type TokenSnapshot,
} from '../../shared/types.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/db.js';
import { DistributionQueue } from '../src/distribution/queue.js';
import { Bus } from '../src/engine/bus.js';
import { deriveMetrics, toCardMetrics } from '../src/engine/metrics.js';
import type { Scanner } from '../src/engine/scanner.js';
import { createServer, type ServerDeps } from '../src/http/server.js';
import { openSse } from '../src/http/sse.js';
import { METHODOLOGIES, SOURCE_POLICY } from '../src/quant/library.js';
import type { RadarService } from '../src/research/radar.js';
import { parseGtPools } from '../src/sources/geckoterminal.js';

/** When the GeckoTerminal fixtures were captured. */
const T0 = Date.UTC(2026, 9, 1, 21, 10);
const SEC = 1000;

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const SOLANA_TOKENS = parseGtPools(fixture('gt_new_pools_solana.json'), 'solana', T0);
const BASE_TOKENS = parseGtPools(fixture('gt_new_pools_base.json'), 'base', T0);

const UNKNOWN_REGIME: MarketRegime = {
  label: 'unknown',
  breadthPct: null,
  medianH1ChangePct: null,
  sampleSize: 0,
  computedAt: T0,
};

function token(list: TokenSnapshot[], i: number): TokenSnapshot {
  const s = list[i];
  if (!s) throw new Error(`fixture has no token #${i}`);
  return s;
}

/** An article about a real fixture token; the prose fields are test placeholders. */
function article(s: TokenSnapshot, createdAt: number, severity: Severity): NewsArticle {
  return {
    id: `art-${s.chain}-${createdAt}`,
    createdAt,
    chain: s.chain,
    address: s.address,
    symbol: s.symbol,
    name: s.name,
    imageUrl: s.imageUrl,
    severity,
    score: severity === 'BREAKING' ? 80 : 65,
    headline: `${s.symbol} test headline`,
    lede: 'test lede',
    aiLine: 'test line',
    whyItMatters: ['one', 'two', 'three'],
    quantAnalysis: 'test analysis',
    outlook: { bullish: 'bull', neutral: 'neutral', risk: 'risk' },
    engine: 'rules',
    model: null,
    lang: 'en',
    metrics: toCardMetrics(s, deriveMetrics(s, [], createdAt)),
    signals: [],
    quant: { top: null, matches: [], regime: UNKNOWN_REGIME, riskFlags: [] },
    pipeline: {
      detectedAt: createdAt,
      analyzedAt: createdAt,
      quantAt: createdAt,
      writtenAt: createdAt,
      publishedAt: createdAt,
    },
    links: { dexscreener: null, explorer: null, website: null, twitter: null, telegram: null },
    updateOf: null,
  };
}

function detection(s: TokenSnapshot, ts: number, articleId: string | null = null): DetectionEvent {
  return {
    id: `det-${s.chain}-${s.address}-${ts}`,
    ts,
    chain: s.chain,
    address: s.address,
    symbol: s.symbol,
    name: s.name,
    score: 50,
    severity: 'WATCH',
    signals: [],
    articleId,
  };
}

function radarReport(id: string, query: string, status: RadarReport['status'], updatedAt = T0): RadarReport {
  return {
    id,
    query,
    createdAt: T0,
    updatedAt,
    status,
    error: null,
    stages: [],
    candidates: [],
    token: null,
    snapshot: null,
    metrics: null,
    detection: null,
    quant: null,
    intel: [],
    brief: null,
    unavailable: [],
  };
}

/** Records calls and lets a test drive report updates like the real service does. */
class FakeRadar {
  readonly started: Array<{ query: string; chain: ChainId | undefined }> = [];
  private readonly reports = new Map<string, RadarReport>();
  private readonly listeners = new Map<string, Set<(r: RadarReport) => void>>();

  start(query: string, chain?: ChainId): RadarReport {
    this.started.push({ query, chain });
    const r = radarReport(`radar-${this.started.length}`, query, 'running');
    this.reports.set(r.id, r);
    return r;
  }

  get(id: string): RadarReport | null {
    return this.reports.get(id) ?? null;
  }

  subscribe(id: string, fn: (r: RadarReport) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(fn);
    this.listeners.set(id, set);
    return () => set.delete(fn);
  }

  listenerCount(id: string): number {
    return this.listeners.get(id)?.size ?? 0;
  }

  publish(r: RadarReport): void {
    this.reports.set(r.id, r);
    for (const fn of this.listeners.get(r.id) ?? []) fn(r);
  }
}

function fakeScanner(chains: ChainInfo[] = [], lastScanAt: number | null = null): Scanner {
  const scanner = { chainInfo: () => chains, lastScanAt: () => lastScanAt, start: () => {}, stop: async () => {} };
  return scanner as unknown as Scanner;
}

interface Harness {
  app: FastifyInstance;
  db: Db;
  bus: Bus;
  radar: FakeRadar;
  config: AppConfig;
  distribution: DistributionQueue;
}

const startedAt = Date.now();

async function harness(over: Partial<ServerDeps> = {}): Promise<Harness> {
  const db = openDb(':memory:');
  const bus = new Bus();
  const config = loadConfig({ CHAINS: 'solana,base' });
  const distribution = new DistributionQueue({ db, config });
  const radar = new FakeRadar();
  const app = await createServer({
    config,
    db,
    bus,
    scanner: fakeScanner(),
    radar: radar as unknown as RadarService,
    distribution,
    startedAt,
    webDist: null,
    ...over,
  });
  return { app, db, bus, radar, config, distribution };
}

let h: Harness;

/** Swaps the current server for one built with different dependencies. */
async function rebuild(over: Partial<ServerDeps>): Promise<void> {
  await h.app.close();
  h.db.close();
  h = await harness(over);
}

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.app.close();
  h.db.close();
  vi.useRealTimers();
});

const radarPost = (payload: unknown, remoteAddress = '203.0.113.7') =>
  h.app.inject({ method: 'POST', url: '/api/radar', payload: payload as object, remoteAddress });

/* ───────────── REST ───────────── */

describe('health and security headers', () => {
  it('answers health with uptime and hardening headers', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data: https:");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toMatch(/googleapis|gstatic/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('GET /api/stats', () => {
  it('builds the header numbers from the database and scanner state', async () => {
    const now = Date.now();
    const chain: ChainInfo = {
      id: 'solana',
      name: 'Solana',
      short: 'SOL',
      nativeSymbol: 'SOL',
      color: '#b18cff',
      status: 'scanning',
      lastScanAt: now - 5 * SEC,
      lastError: null,
      tokensSeen24h: 1,
    };
    await rebuild({ scanner: fakeScanner([chain], now - 5 * SEC) });
    const s = { ...token(SOLANA_TOKENS, 0), ts: now - 10 * SEC };
    h.db.insertSnapshot(s);
    h.db.insertDetection(detection(s, now - 10 * SEC));

    const res = await h.app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(200);
    const stats = res.json();
    expect(stats).toMatchObject({
      engine: { status: 'active', ai: 'rules', model: null, aiError: null },
      chainsScanning: 1,
      chainsTotal: 1,
      tokensAnalyzed24h: 1,
      anomalies24h: 1,
      breaking24h: 0,
      articles24h: 0,
      lastScanAt: now - 5 * SEC,
      startedAt,
      distribution: { channels: [], sent24h: 0 },
    });
    expect(stats.chains).toEqual([chain]);
  });

  it('reports a starting engine before the first scan', async () => {
    const stats = (await h.app.inject({ method: 'GET', url: '/api/stats' })).json();
    expect(stats.engine.status).toBe('starting');
    expect(stats.lastScanAt).toBeNull();
    expect(stats.tokensAnalyzed24h).toBe(0);
  });
});

describe('GET /api/feed', () => {
  /** five articles, newest first: sol0 BREAKING, base0 ALERT, sol1 ALERT, base1 BREAKING, sol2 ALERT */
  function seedFeed(): NewsArticle[] {
    const articles = [
      article(token(SOLANA_TOKENS, 0), T0 - 1 * SEC, 'BREAKING'),
      article(token(BASE_TOKENS, 0), T0 - 2 * SEC, 'ALERT'),
      article(token(SOLANA_TOKENS, 1), T0 - 3 * SEC, 'ALERT'),
      article(token(BASE_TOKENS, 1), T0 - 4 * SEC, 'BREAKING'),
      article(token(SOLANA_TOKENS, 2), T0 - 5 * SEC, 'ALERT'),
    ];
    for (const a of articles) h.db.insertArticle(a);
    return articles;
  }

  const feed = async (query: string) => {
    const res = await h.app.inject({ method: 'GET', url: `/api/feed${query}` });
    expect(res.statusCode).toBe(200);
    return res.json() as { articles: NewsArticle[]; nextBefore: number | null };
  };

  it('returns the newest articles with the default limit', async () => {
    const seeded = seedFeed();
    const page = await feed('');
    expect(page.articles.map((a) => a.id)).toEqual(seeded.map((a) => a.id));
    expect(page.nextBefore).toBeNull();
  });

  it('paginates with nextBefore until the feed is exhausted', async () => {
    const seeded = seedFeed();
    const seen: string[] = [];
    let cursor: number | null = null;
    let pages = 0;
    do {
      const page = await feed(`?limit=2${cursor != null ? `&before=${cursor}` : ''}`);
      seen.push(...page.articles.map((a) => a.id));
      const last = page.articles.at(-1);
      expect(page.nextBefore).toBe(page.articles.length === 2 && last ? last.createdAt : null);
      cursor = page.nextBefore;
      pages++;
    } while (cursor != null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(seeded.map((a) => a.id));
  });

  it('keeps a cursor when the page is exactly full, then returns an empty last page', async () => {
    const seeded = seedFeed();
    const full = await feed('?limit=5');
    expect(full.nextBefore).toBe(seeded[4]?.createdAt);
    const rest = await feed(`?limit=5&before=${full.nextBefore}`);
    expect(rest).toEqual({ articles: [], nextBefore: null });
  });

  it('filters by chain and severity', async () => {
    seedFeed();
    expect((await feed('?chain=base')).articles.every((a) => a.chain === 'base')).toBe(true);
    expect((await feed('?chain=base')).articles).toHaveLength(2);
    expect((await feed('?severity=BREAKING')).articles.map((a) => a.severity)).toEqual(['BREAKING', 'BREAKING']);
    const both = await feed('?chain=solana&severity=ALERT');
    expect(both.articles.map((a) => a.address)).toEqual([
      token(SOLANA_TOKENS, 1).address,
      token(SOLANA_TOKENS, 2).address,
    ]);
    expect((await feed('?chain=ethereum')).articles).toEqual([]);
  });

  it('treats empty parameters as absent', async () => {
    seedFeed();
    expect((await feed('?before=&chain=')).articles).toHaveLength(5);
  });

  it.each([
    'limit=0',
    'limit=101',
    'limit=abc',
    'limit=2.5',
    'before=-1',
    'before=soon',
    'chain=doge',
    'severity=LOW',
    'chain=solana&chain=base',
  ])('rejects %s with 400', async (query) => {
    const res = await h.app.inject({ method: 'GET', url: `/api/feed?${query}` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });
});

describe('GET /api/articles/:id', () => {
  it('returns 404 for an unknown article', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/articles/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('joins distribution items and earlier detections of the same token', async () => {
    const s = token(SOLANA_TOKENS, 0);
    const a = article(s, T0, 'BREAKING');
    h.db.insertArticle(a);
    const items = h.distribution.enqueue(a);
    const earlier = detection(s, T0 - 60 * SEC);
    const own = detection(s, T0 - 5 * SEC, a.id);
    h.db.insertDetection(earlier);
    h.db.insertDetection(own);
    h.db.insertDetection(detection(s, T0 + 60 * SEC)); // after the article
    h.db.insertDetection(detection(token(SOLANA_TOKENS, 1), T0 - 30 * SEC)); // other token

    const res = await h.app.inject({ method: 'GET', url: `/api/articles/${a.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.article).toEqual(a);
    expect(body.distribution.map((d: { id: string }) => d.id).sort()).toEqual(items.map((d) => d.id).sort());
    const channels = body.distribution.map((d: { channel: string }) => d.channel).sort();
    expect(channels).toEqual(['discord', 'telegram', 'webhook', 'x']);
    expect(body.related.map((e: DetectionEvent) => e.id)).toEqual([own.id, earlier.id]);
  });
});

describe('GET /api/detections', () => {
  it('returns the newest detections, honouring the limit', async () => {
    const older = detection(token(SOLANA_TOKENS, 0), T0 - 10 * SEC);
    const newer = detection(token(BASE_TOKENS, 0), T0);
    h.db.insertDetection(older);
    h.db.insertDetection(newer);
    const all = await h.app.inject({ method: 'GET', url: '/api/detections' });
    expect(all.json().events.map((e: DetectionEvent) => e.id)).toEqual([newer.id, older.id]);
    const one = await h.app.inject({ method: 'GET', url: '/api/detections?limit=1' });
    expect(one.json().events).toHaveLength(1);
    expect((await h.app.inject({ method: 'GET', url: '/api/detections?limit=500' })).statusCode).toBe(400);
  });
});

describe('quant endpoints', () => {
  it('serves the methodology library with disclaimer and source policy', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/quant/library' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.methodologies).toHaveLength(METHODOLOGIES.length);
    expect(body.methodologies[0]).toMatchObject({ id: METHODOLOGIES[0]?.id, references: expect.any(Array) });
    expect(body.disclaimer).toBe(QUANT_DISCLAIMER);
    expect(body.sourcePolicy).toBe(SOURCE_POLICY);
    expect(res.headers['cache-control']).toMatch(/^public/);
  });

  it('computes leaders from recent snapshots, links articles and caches for 15 s', async () => {
    // the fixture pools are a few minutes old: only some clear $5K liquidity and $2K of 1h volume
    await rebuild({ config: loadConfig({ CHAINS: 'solana,base', MIN_LIQUIDITY_USD: '5000', MIN_VOLUME_H1_USD: '2000' }) });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0 + 60 * SEC);
    const tokens = [...SOLANA_TOKENS, ...BASE_TOKENS];
    const articleIds = new Map<string, string>();
    tokens.forEach((s, i) => {
      h.db.insertSnapshot(s);
      const a = article(s, T0 - (i + 1) * SEC, 'ALERT');
      h.db.insertArticle(a);
      const key = `${s.chain}:${s.address}`;
      if (!articleIds.has(key)) articleIds.set(key, a.id); // the newest article of a token wins
    });

    const first = (await h.app.inject({ method: 'GET', url: '/api/quant/leaders' })).json();
    expect(first.computedAt).toBe(T0 + 60 * SEC);
    expect(['risk-on', 'neutral', 'risk-off', 'unknown']).toContain(first.regime.label);
    const methodologyIds = first.leaders.map((l: { methodologyId: string }) => l.methodologyId);
    expect(methodologyIds).toEqual(METHODOLOGIES.map((m) => m.id));
    const leaderTokens = first.leaders.flatMap((l: { tokens: unknown[] }) => l.tokens);
    expect(leaderTokens.length).toBeGreaterThan(0);
    for (const t of leaderTokens) {
      expect(t.score).toBeGreaterThan(0);
      expect(t.articleId).toBe(articleIds.get(`${t.chain}:${t.address}`));
    }
    // dust never leads a methodology, however well its one trade "fits"
    const eligible = new Set(
      tokens.filter((s) => (s.liquidityUsd ?? 0) >= 5000 && (s.volumeUsd.h1 ?? 0) >= 2000).map((s) => `${s.chain}:${s.address}`),
    );
    for (const t of leaderTokens) expect(eligible.has(`${t.chain}:${t.address}`)).toBe(true);

    vi.setSystemTime(T0 + 70 * SEC);
    const cached = (await h.app.inject({ method: 'GET', url: '/api/quant/leaders' })).json();
    expect(cached.computedAt).toBe(T0 + 60 * SEC);
    vi.setSystemTime(T0 + 76 * SEC);
    const fresh = (await h.app.inject({ method: 'GET', url: '/api/quant/leaders' })).json();
    expect(fresh.computedAt).toBe(T0 + 76 * SEC);
  });

  it('returns empty leaderboards when nothing was observed recently', async () => {
    const body = (await h.app.inject({ method: 'GET', url: '/api/quant/leaders' })).json();
    expect(body.regime).toMatchObject({ label: 'unknown', sampleSize: 0, breadthPct: null });
    expect(body.leaders.every((l: { tokens: unknown[] }) => l.tokens.length === 0)).toBe(true);
  });
});

describe('POST /api/radar', () => {
  it.each([
    ['no body', undefined],
    ['missing query', {}],
    ['empty query', { query: '' }],
    ['blank query', { query: '   ' }],
    ['query over 120 chars', { query: 'x'.repeat(121) }],
    ['non-string query', { query: 42 }],
    ['unknown chain', { query: 'PEPE', chain: 'doge' }],
    ['chain without adapter', { query: 'PEPE', chain: 'ethereum' }],
  ])('rejects %s with 400', async (_name, payload) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/radar',
      ...(payload === undefined ? {} : { payload }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
    expect(h.radar.started).toEqual([]);
  });

  it('starts a radar run with the trimmed query and optional chain', async () => {
    const res = await radarPost({ query: '  $PEPE ', chain: 'base' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id: 'radar-1' });
    expect((await radarPost({ query: 'x'.repeat(120), chain: null })).statusCode).toBe(202);
    expect(h.radar.started).toEqual([
      { query: '$PEPE', chain: 'base' },
      { query: 'x'.repeat(120), chain: undefined },
    ]);
  });

  it('rejects bodies over 4 KB with 413', async () => {
    const res = await radarPost({ query: 'PEPE', padding: 'x'.repeat(5000) });
    expect(res.statusCode).toBe(413);
    expect(h.radar.started).toEqual([]);
  });

  it('rate limits to 10 searches per minute per IP', async () => {
    for (let i = 0; i < 10; i++) expect((await radarPost({ query: `T${i}` })).statusCode).toBe(202);
    const limited = await radarPost({ query: 'ONE-TOO-MANY' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(h.radar.started).toHaveLength(10);
    // another client is unaffected
    expect((await radarPost({ query: 'PEPE' }, '198.51.100.9')).statusCode).toBe(202);
  });
});

describe('GET /api/radar/:id', () => {
  it('returns a known report and 404 otherwise', async () => {
    const { id } = (await radarPost({ query: 'BONK' })).json();
    const res = await h.app.inject({ method: 'GET', url: `/api/radar/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, query: 'BONK', status: 'running' });
    expect((await h.app.inject({ method: 'GET', url: '/api/radar/nope' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/api/radar/nope/stream' })).statusCode).toBe(404);
  });
});

/* ───────────── static web app ───────────── */

describe('static web app', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hootradar-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>HootRadar</title><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("hoot");');
    await rebuild({ webDist: dir });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves index.html without long-term caching', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<div id="root">');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('serves hashed assets as immutable', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('serves assets written after startup (web rebuilt while the server runs)', async () => {
    writeFileSync(join(dir, 'assets', 'index-def456.js'), 'console.log("rebuilt");');
    const res = await h.app.inject({ method: 'GET', url: '/assets/index-def456.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('rebuilt');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to index.html for client routes only', async () => {
    const spa = await h.app.inject({ method: 'GET', url: '/intelligence?tab=1' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<div id="root">');

    for (const url of ['/assets/missing-123.js', '/favicon.ico', '/api/unknown']) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not_found' });
    }
    expect((await h.app.inject({ method: 'POST', url: '/intelligence' })).statusCode).toBe(404);
  });

  it('serves the API only when the build has no index.html', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'hootradar-empty-'));
    try {
      await rebuild({ webDist: empty });
      expect((await h.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
      expect((await h.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

/* ───────────── SSE over a real socket ───────────── */

interface SseClient {
  status: number;
  header(name: string): string | undefined;
  next(): Promise<{ event: string; data: any } | null>;
  close(): void;
}

/** Minimal EventSource-style reader on node:http (no connection pooling, so closing is immediate). */
async function connect(url: string): Promise<SseClient> {
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpRequest(url, { agent: false, headers: { accept: 'text/event-stream' } }, resolve);
    req.on('error', reject);
    req.end();
  });
  res.setEncoding('utf8');
  const chunks = res[Symbol.asyncIterator]() as AsyncIterator<string>;
  let buffer = '';
  return {
    status: res.statusCode ?? 0,
    header: (name) => {
      const v = res.headers[name.toLowerCase()];
      return Array.isArray(v) ? v.join(', ') : v;
    },
    async next() {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const lines = buffer.slice(0, end).split('\n');
          buffer = buffer.slice(end + 2);
          const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
          const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
          if (event && data) return { event, data: JSON.parse(data) };
          continue; // retry hint or heartbeat comment
        }
        const chunk = await chunks.next();
        if (chunk.done) return null;
        buffer += chunk.value;
      }
    },
    close: () => res.destroy(),
  };
}

async function listen(): Promise<string> {
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address = h.app.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('GET /api/stream', () => {
  it('sends hello, then forwards live articles and detections', async () => {
    const seeded = article(token(SOLANA_TOKENS, 0), T0, 'BREAKING');
    h.db.insertArticle(seeded);
    h.db.insertDetection(detection(token(SOLANA_TOKENS, 0), T0 - SEC, seeded.id));
    const base = await listen();
    const client = await connect(`${base}/api/stream`);
    try {
      expect(client.status).toBe(200);
      expect(client.header('content-type')).toMatch(/^text\/event-stream/);
      expect(client.header('cache-control')).toBe('no-cache, no-transform');
      expect(client.header('x-accel-buffering')).toBe('no');

      const hello = await client.next();
      expect(hello?.event).toBe('hello');
      expect(hello?.data.type).toBe('hello');
      expect(hello?.data.articles.map((a: NewsArticle) => a.id)).toEqual([seeded.id]);
      expect(hello?.data.events).toHaveLength(1);
      expect(hello?.data.stats.engine.ai).toBe('rules');

      const live = article(token(BASE_TOKENS, 0), T0 + SEC, 'ALERT');
      h.bus.emit('article', live);
      const detected = detection(token(BASE_TOKENS, 1), T0 + 2 * SEC);
      h.bus.emit('detection', detected);
      expect(await client.next()).toEqual({ event: 'article', data: { type: 'article', article: live } });
      expect(await client.next()).toEqual({ event: 'detection', data: { type: 'detection', event: detected } });
    } finally {
      client.close();
    }
  });

  it('closes open streams when the server shuts down', async () => {
    const base = await listen();
    const client = await connect(`${base}/api/stream`);
    expect((await client.next())?.event).toBe('hello');
    const started = Date.now();
    await h.app.close();
    expect(Date.now() - started).toBeLessThan(2000);
    // the stream is cut, so the client sees an error or the end of the body, never another event
    expect(await client.next().catch(() => null)).toBeNull();
    client.close();
  });
});

describe('GET /api/radar/:id/stream', () => {
  it('streams updates of a running report and ends when it is final', async () => {
    const { id } = (await radarPost({ query: 'BONK' })).json();
    const base = await listen();
    const client = await connect(`${base}/api/radar/${id}/stream`);
    try {
      expect(client.header('content-type')).toMatch(/^text\/event-stream/);
      const first = await client.next();
      expect(first?.event).toBe('report');
      expect(first?.data.report).toMatchObject({ id, status: 'running' });
      expect(h.radar.listenerCount(id)).toBe(1);

      h.radar.publish(radarReport(id, 'BONK', 'running', T0 + SEC));
      h.radar.publish(radarReport(id, 'BONK', 'running', T0 + SEC)); // identical state is not re-sent
      h.radar.publish(radarReport(id, 'BONK', 'done', T0 + 2 * SEC));

      const update = await client.next();
      expect(update?.event).toBe('report');
      expect(update?.data.report.updatedAt).toBe(T0 + SEC);
      const end = await client.next();
      expect(end?.event).toBe('end');
      expect(end?.data).toMatchObject({ type: 'end', report: { id, status: 'done' } });
      expect(await client.next()).toBeNull();
      await vi.waitFor(() => expect(h.radar.listenerCount(id)).toBe(0));
    } finally {
      client.close();
    }
  });

  it('sends the report and end right away for a finished report', async () => {
    const { id } = (await radarPost({ query: 'BONK' })).json();
    h.radar.publish(radarReport(id, 'BONK', 'not_found', T0 + SEC));
    const base = await listen();
    const client = await connect(`${base}/api/radar/${id}/stream`);
    try {
      expect((await client.next())?.event).toBe('report');
      expect((await client.next())?.data).toMatchObject({ type: 'end', report: { status: 'not_found' } });
      expect(await client.next()).toBeNull();
      expect(h.radar.listenerCount(id)).toBe(0);
    } finally {
      client.close();
    }
  });

  it('unsubscribes when the client goes away', async () => {
    const { id } = (await radarPost({ query: 'BONK' })).json();
    const base = await listen();
    const client = await connect(`${base}/api/radar/${id}/stream`);
    expect((await client.next())?.event).toBe('report');
    expect(h.radar.listenerCount(id)).toBe(1);
    client.close();
    await vi.waitFor(() => expect(h.radar.listenerCount(id)).toBe(0));
  });
});

/* ───────────── SSE backpressure ───────────── */

/** Just enough of ServerResponse for openSse; `accept` decides what write() reports. */
class FakeResponse extends EventEmitter {
  readonly chunks: string[] = [];
  accept = true;
  ended = false;
  writableFinished = false;
  destroyed = false;
  socket = null;
  writeHead(): this {
    return this;
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.accept;
  }
  end(): void {
    this.ended = true;
    this.writableFinished = true;
    this.emit('close');
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

function fakeStream() {
  const res = new FakeResponse();
  const reply = { hijack: () => {}, raw: res } as unknown as FastifyReply;
  const stream = openSse(reply);
  const events = () => res.chunks.filter((c) => c.startsWith('event: ')).map((c) => c.split('\n')[0]?.slice(7));
  return { res, stream, events };
}

describe('SSE stream backpressure', () => {
  it('drops droppable frames and queues the rest while the socket is congested', () => {
    const { res, stream, events } = fakeStream();
    expect(res.chunks[0]).toMatch(/^retry: \d+\n\n$/);
    res.accept = false;
    expect(stream.send('article', { n: 1 })).toBe(true); // written; the socket now reports congestion
    expect(stream.send('stats', {}, { droppable: true })).toBe(false);
    expect(stream.send('article', { n: 2 })).toBe(true);
    expect(stream.send('detection', { n: 3 })).toBe(true);
    expect(events()).toEqual(['article']);

    res.accept = true;
    res.emit('drain');
    expect(events()).toEqual(['article', 'article', 'detection']);
    expect(res.chunks.at(-2)).toBe('event: article\ndata: {"n":2}\n\n');
    expect(stream.send('stats', {}, { droppable: true })).toBe(true);
  });

  it('cuts off a client that falls more than 1 MiB behind', () => {
    const { res, stream } = fakeStream();
    const closed = vi.fn();
    stream.onClose(closed);
    res.accept = false;
    stream.send('article', { n: 0 });
    const big = 'x'.repeat(200 * 1024);
    for (let i = 0; i < 5; i++) expect(stream.send('article', { big })).toBe(true);
    expect(stream.send('article', { big })).toBe(false);
    expect(res.destroyed).toBe(true);
    expect(stream.closed).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('flushes queued frames before ending on close()', () => {
    const { res, stream, events } = fakeStream();
    res.accept = false;
    stream.send('report', { n: 1 });
    stream.send('end', { n: 2 });
    stream.close();
    expect(stream.send('report', { n: 3 })).toBe(false);
    expect(res.ended).toBe(false);
    res.accept = true;
    res.emit('drain');
    expect(events()).toEqual(['report', 'end']);
    expect(res.ended).toBe(true);
  });
});
