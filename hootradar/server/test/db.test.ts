import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  DetectionEvent,
  DistributionItem,
  NewsArticle,
  RadarReport,
  TokenSnapshot,
} from '../../shared/types.js';
import { openDb, tokenKey, type Db } from '../src/db/db.js';
import { parseGtPools } from '../src/sources/geckoterminal.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 1, 21, 10);

const SOL_A = '6nyVgjjPGY9c7QpjMUPY8vS6sLzVoiq9VyxYoTvmpump';
const SOL_B = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const EVM_CHECKSUM = '0x47A0848d60F9341f55bD2fD6bcAf05816FFDB028';

function snap(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    chain: 'solana',
    address: SOL_A,
    symbol: 'FIRED',
    name: 'Fired',
    pairAddress: null,
    dex: null,
    ts: T0,
    priceUsd: null,
    marketCapUsd: null,
    fdvUsd: null,
    liquidityUsd: null,
    volumeUsd: {},
    priceChangePct: {},
    txns: {},
    holders: null,
    top10HolderPct: null,
    createdAt: null,
    imageUrl: null,
    links: [],
    security: null,
    sources: ['geckoterminal'],
    boosted: false,
    ...over,
  };
}

function detection(over: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    id: crypto.randomUUID(),
    ts: T0,
    chain: 'solana',
    address: SOL_A,
    symbol: 'FIRED',
    name: 'Fired',
    score: 50,
    severity: 'WATCH',
    signals: [{ code: 'volume_surge', label: 'Volume 4.2x vs 1h avg', value: 4.2, weight: 12.1 }],
    articleId: null,
    ...over,
  };
}

function article(over: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id: crypto.randomUUID(),
    createdAt: T0,
    chain: 'solana',
    address: SOL_A,
    symbol: 'FIRED',
    name: 'Fired',
    imageUrl: null,
    severity: 'ALERT',
    score: 66,
    headline: 'Volume surges on FIRED',
    lede: 'Lede.',
    aiLine: 'Line.',
    whyItMatters: ['a', 'b', 'c'],
    quantAnalysis: 'Quant.',
    outlook: { bullish: 'b', neutral: 'n', risk: 'r' },
    engine: 'rules',
    model: null,
    lang: 'en',
    metrics: {
      priceUsd: null,
      marketCapUsd: null,
      mcIsFdv: false,
      liquidityUsd: null,
      volumeUsd: null,
      volumeWindow: null,
      txPerMin: null,
      buyPct: null,
      sellPct: null,
      holders: null,
      holdersGrowthPct: null,
      priceChangeH1Pct: null,
      ageMinutes: null,
    },
    signals: [],
    quant: {
      top: null,
      matches: [],
      regime: { label: 'unknown', breadthPct: null, medianH1ChangePct: null, sampleSize: 0, computedAt: T0 },
      riskFlags: [],
    },
    pipeline: { detectedAt: T0, analyzedAt: T0, quantAt: T0, writtenAt: T0, publishedAt: T0 },
    links: { dexscreener: null, explorer: null, website: null, twitter: null, telegram: null },
    updateOf: null,
    ...over,
  };
}

function distItem(over: Partial<DistributionItem> = {}): DistributionItem {
  return {
    id: crypto.randomUUID(),
    articleId: 'a1',
    channel: 'telegram',
    payload: '<b>hi</b>',
    status: 'queued',
    createdAt: T0,
    sentAt: null,
    error: null,
    ...over,
  };
}

function radar(over: Partial<RadarReport> = {}): RadarReport {
  return {
    id: crypto.randomUUID(),
    query: 'BONK',
    createdAt: T0,
    updatedAt: T0,
    status: 'running',
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
    ...over,
  };
}

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
});

describe('tokens and snapshots', () => {
  it('round-trips real parsed GeckoTerminal snapshots without loss', () => {
    const json = JSON.parse(readFileSync(new URL('./fixtures/gt_new_pools_base.json', import.meta.url), 'utf8'));
    const parsed = parseGtPools(json, 'base', T0);
    expect(parsed.length).toBeGreaterThan(0);
    for (const s of parsed) {
      db.upsertToken(s);
      db.insertSnapshot(s);
    }
    for (const s of parsed) {
      const history = db.history(s.chain, s.address, T0 - HOUR);
      expect(history.at(-1)).toEqual(s);
    }
  });

  it('returns history oldest → newest within the window', () => {
    db.insertSnapshot(snap({ ts: T0 - 30 * MIN, priceUsd: 1 }));
    db.insertSnapshot(snap({ ts: T0, priceUsd: 3 }));
    db.insertSnapshot(snap({ ts: T0 - 10 * MIN, priceUsd: 2 }));
    db.insertSnapshot(snap({ ts: T0 - 3 * HOUR, priceUsd: 0 }));
    db.insertSnapshot(snap({ address: SOL_B, ts: T0, priceUsd: 9 }));

    expect(db.history('solana', SOL_A, T0 - HOUR).map((s) => s.priceUsd)).toEqual([1, 2, 3]);
  });

  it('keys EVM addresses case-insensitively but keeps the original casing', () => {
    db.upsertToken(snap({ chain: 'base', address: EVM_CHECKSUM, createdAt: T0 - HOUR }));
    db.insertSnapshot(snap({ chain: 'base', address: EVM_CHECKSUM }));

    expect(tokenKey('base', EVM_CHECKSUM)).toBe(`base:${EVM_CHECKSUM.toLowerCase()}`);
    const history = db.history('base', EVM_CHECKSUM.toLowerCase(), 0);
    expect(history).toHaveLength(1);
    expect(history[0]?.address).toBe(EVM_CHECKSUM);
    expect(db.trackedAddresses('base', 24, 10, T0)).toEqual([EVM_CHECKSUM]);
  });

  it('keeps Solana addresses case-sensitive', () => {
    db.insertSnapshot(snap({ address: SOL_A }));
    expect(db.history('solana', SOL_A.toLowerCase(), 0)).toEqual([]);
    expect(tokenKey('solana', SOL_A)).toBe(`solana:${SOL_A}`);
  });

  it('latestSnapshots returns the newest snapshot per token, newest first', () => {
    db.insertSnapshot(snap({ address: SOL_A, ts: T0 - 20 * MIN, priceUsd: 1 }));
    db.insertSnapshot(snap({ address: SOL_A, ts: T0 - 5 * MIN, priceUsd: 2 }));
    db.insertSnapshot(snap({ address: SOL_B, ts: T0 - 2 * MIN, priceUsd: 10 }));
    db.insertSnapshot(snap({ chain: 'base', address: EVM_CHECKSUM, ts: T0 - 90 * MIN, priceUsd: 99 }));

    const latest = db.latestSnapshots(T0 - HOUR);
    expect(latest.map((s) => [s.address, s.priceUsd])).toEqual([
      [SOL_B, 10],
      [SOL_A, 2],
    ]);
    expect(db.latestSnapshots(T0 - HOUR, 1).map((s) => s.address)).toEqual([SOL_B]);
  });

  it('upsertToken keeps the earliest creation time and never lets an older observation win', () => {
    db.upsertToken(snap({ ts: T0, symbol: 'NEW', createdAt: T0 - 2 * HOUR }));
    db.upsertToken(snap({ ts: T0 - 10 * MIN, symbol: 'OLD', createdAt: T0 - 3 * HOUR }));
    db.upsertToken(snap({ ts: T0 - MIN, symbol: '', createdAt: null }));
    db.upsertToken(snap({ address: SOL_B, ts: T0 - 5 * MIN, createdAt: T0 - HOUR }));

    // created 3 h ago → outside a 2.5 h window, inside a 4 h window
    expect(db.trackedAddresses('solana', 2.5, 10, T0)).toEqual([SOL_B]);
    // last_seen stayed at T0 despite the later-arriving older observations → most recent first
    expect(db.trackedAddresses('solana', 4, 10, T0)).toEqual([SOL_A, SOL_B]);
  });

  it('trackedAddresses filters by age (first sighting when creation is unknown) and orders by activity', () => {
    db.upsertToken(snap({ address: 'A1111111111111111111111111111111', createdAt: T0 - 2 * HOUR, ts: T0 - 5 * MIN }));
    db.upsertToken(snap({ address: 'B1111111111111111111111111111111', createdAt: T0 - 30 * HOUR, ts: T0 }));
    db.upsertToken(snap({ address: 'C1111111111111111111111111111111', createdAt: null, ts: T0 - MIN }));
    db.upsertToken(snap({ address: 'D1111111111111111111111111111111', createdAt: T0 - HOUR, ts: T0 - 20 * MIN }));
    db.upsertToken(snap({ chain: 'base', address: EVM_CHECKSUM, createdAt: T0 - HOUR, ts: T0 }));

    expect(db.trackedAddresses('solana', 24, 10, T0)).toEqual([
      'C1111111111111111111111111111111',
      'A1111111111111111111111111111111',
      'D1111111111111111111111111111111',
    ]);
    expect(db.trackedAddresses('solana', 24, 2, T0)).toHaveLength(2);
  });

  it('coalesces identical observations but stores every change', () => {
    const base = snap({ priceUsd: 1, liquidityUsd: 10_000 });
    db.insertSnapshot(base);
    db.insertSnapshot({ ...base, ts: T0 + 20_000 }); // unchanged → coalesced
    db.insertSnapshot({ ...base, ts: T0 + 40_000, priceUsd: 1.1 }); // changed → stored
    db.insertSnapshot({ ...base, ts: T0 + 60_000, priceUsd: 1.1 }); // unchanged → coalesced
    db.insertSnapshot({ ...base, ts: T0 + 40_000 + 5 * MIN, priceUsd: 1.1 }); // unchanged but 5 min later → stored

    expect(db.history('solana', SOL_A, 0).map((s) => [s.ts - T0, s.priceUsd])).toEqual([
      [0, 1],
      [40_000, 1.1],
      [40_000 + 5 * MIN, 1.1],
    ]);
  });
});

describe('detections', () => {
  it('lists newest first, per token, and finds the last one', () => {
    const a = detection({ ts: T0 - 10 * MIN, score: 46 });
    const b = detection({ ts: T0, score: 70, severity: 'ALERT', articleId: 'art-1' });
    const other = detection({ address: SOL_B, ts: T0 - 5 * MIN });
    [a, b, other].forEach((e) => db.insertDetection(e));

    expect(db.recentDetections(10).map((e) => e.id)).toEqual([b.id, other.id, a.id]);
    expect(db.recentDetections(1)).toEqual([b]);
    expect(db.detectionsFor('solana', SOL_A, 10).map((e) => e.id)).toEqual([b.id, a.id]);
    expect(db.lastDetectionFor('solana', SOL_A)).toEqual(b);
    expect(db.lastDetectionFor('solana', 'Unknown1111111111111111111111111')).toBeNull();
  });

  it('matches EVM detections regardless of address casing', () => {
    const e = detection({ chain: 'bsc', address: EVM_CHECKSUM });
    db.insertDetection(e);
    expect(db.lastDetectionFor('bsc', EVM_CHECKSUM.toLowerCase())).toEqual(e);
  });
});

describe('articles', () => {
  it('stores, reads and pages articles newest first with filters', () => {
    const a1 = article({ createdAt: T0 - 30 * MIN, severity: 'ALERT' });
    const a2 = article({ createdAt: T0 - 20 * MIN, severity: 'BREAKING', chain: 'base', address: EVM_CHECKSUM });
    const a3 = article({ createdAt: T0 - 10 * MIN, severity: 'BREAKING' });
    [a1, a2, a3].forEach((a) => db.insertArticle(a));

    expect(db.getArticle(a2.id)).toEqual(a2);
    expect(db.getArticle('missing')).toBeNull();
    expect(db.listArticles({ limit: 10 }).map((a) => a.id)).toEqual([a3.id, a2.id, a1.id]);
    expect(db.listArticles({ limit: 2 }).map((a) => a.id)).toEqual([a3.id, a2.id]);
    expect(db.listArticles({ limit: 10, before: a2.createdAt }).map((a) => a.id)).toEqual([a1.id]);
    expect(db.listArticles({ limit: 10, chain: 'base' }).map((a) => a.id)).toEqual([a2.id]);
    expect(db.listArticles({ limit: 10, severity: 'BREAKING' }).map((a) => a.id)).toEqual([a3.id, a2.id]);
    expect(db.listArticles({ limit: 10, chain: 'solana', severity: 'ALERT' }).map((a) => a.id)).toEqual([a1.id]);
  });

  it('finds the last article per token and counts recent ones', () => {
    const older = article({ createdAt: T0 - 2 * HOUR });
    const newer = article({ createdAt: T0 - 5 * MIN });
    db.insertArticle(older);
    db.insertArticle(newer);
    db.insertArticle(article({ address: SOL_B, createdAt: T0 }));

    expect(db.lastArticleFor('solana', SOL_A)?.id).toBe(newer.id);
    expect(db.lastArticleFor('ethereum', EVM_CHECKSUM)).toBeNull();
    expect(db.articlesSince(T0 - HOUR)).toBe(2);
  });
});

describe('distribution', () => {
  it('inserts, updates and lists items', () => {
    const tg = distItem({ createdAt: T0 });
    const x = distItem({ channel: 'x', status: 'ready', createdAt: T0 + 1 });
    const other = distItem({ articleId: 'a2', createdAt: T0 - 1 });
    [tg, x, other].forEach((d) => db.insertDistribution(d));

    expect(db.distributionFor('a1').map((d) => d.channel)).toEqual(['telegram', 'x']);
    expect(db.pendingDistribution(10).map((d) => d.id)).toEqual([other.id, tg.id]);

    db.updateDistribution(tg.id, { status: 'sent', sentAt: T0 + 5000 });
    db.updateDistribution(other.id, { status: 'failed', error: 'HTTP 403' });
    db.updateDistribution('missing', { status: 'sent' });

    expect(db.pendingDistribution(10)).toEqual([]);
    expect(db.distributionFor('a1')[0]).toEqual({ ...tg, status: 'sent', sentAt: T0 + 5000 });
    expect(db.distributionFor('a2')[0]).toEqual({ ...other, status: 'failed', error: 'HTTP 403' });
  });
});

describe('radar', () => {
  it('saves and replaces reports', () => {
    const r = radar();
    db.saveRadar(r);
    expect(db.getRadar(r.id)).toEqual(r);
    db.saveRadar({ ...r, status: 'done', updatedAt: T0 + 1000 });
    expect(db.getRadar(r.id)?.status).toBe('done');
    expect(db.getRadar('missing')).toBeNull();
  });
});

describe('counts and prune', () => {
  it('counts distinct tokens per chain, detections, articles and sent items since a timestamp', () => {
    const since = T0 - 24 * HOUR;
    db.insertSnapshot(snap({ address: SOL_A, ts: T0 - HOUR, priceUsd: 1 }));
    db.insertSnapshot(snap({ address: SOL_A, ts: T0, priceUsd: 2 }));
    db.insertSnapshot(snap({ address: SOL_B, ts: T0 }));
    db.insertSnapshot(snap({ chain: 'base', address: EVM_CHECKSUM, ts: T0 }));
    db.insertSnapshot(snap({ chain: 'base', address: EVM_CHECKSUM.toLowerCase(), ts: T0 + 1, priceUsd: 5 }));
    db.insertSnapshot(snap({ chain: 'bsc', address: EVM_CHECKSUM, ts: since - 1 }));

    db.insertDetection(detection({ severity: 'WATCH' }));
    db.insertDetection(detection({ severity: 'BREAKING' }));
    db.insertDetection(detection({ severity: 'BREAKING', ts: since - 1 }));
    db.insertArticle(article());
    db.insertArticle(article({ createdAt: since - 1 }));
    db.insertDistribution(distItem({ status: 'sent', sentAt: T0 }));
    db.insertDistribution(distItem({ status: 'sent', sentAt: since - 1 }));
    db.insertDistribution(distItem({ status: 'ready' }));

    expect(db.counts(since)).toEqual({
      tokensAnalyzed: 3,
      anomalies: 2,
      breaking: 1,
      articles: 1,
      distributed: 1,
      perChainTokens: { solana: 2, base: 1 },
    });
  });

  it('reports zeros on an empty database', () => {
    expect(db.counts(0)).toEqual({
      tokensAnalyzed: 0,
      anomalies: 0,
      breaking: 0,
      articles: 0,
      distributed: 0,
      perChainTokens: {},
    });
  });

  it('prunes snapshots and tokens older than 48 h and radar reports older than 7 days', () => {
    const now = T0;
    db.insertSnapshot(snap({ ts: now - 49 * HOUR, priceUsd: 1 }));
    db.insertSnapshot(snap({ ts: now - 47 * HOUR, priceUsd: 2 }));
    db.upsertToken(snap({ address: SOL_B, ts: now - 49 * HOUR, createdAt: now - 50 * HOUR }));
    db.upsertToken(snap({ address: SOL_A, ts: now - HOUR, createdAt: now - 50 * HOUR }));
    const oldRadar = radar({ createdAt: now - 8 * 24 * HOUR });
    const freshRadar = radar({ createdAt: now - 6 * 24 * HOUR });
    db.saveRadar(oldRadar);
    db.saveRadar(freshRadar);
    const keptArticle = article({ createdAt: now - 30 * 24 * HOUR });
    db.insertArticle(keptArticle);

    db.prune(now);

    expect(db.history('solana', SOL_A, 0).map((s) => s.priceUsd)).toEqual([2]);
    expect(db.trackedAddresses('solana', 72, 10, now)).toEqual([SOL_A]);
    expect(db.getRadar(oldRadar.id)).toBeNull();
    expect(db.getRadar(freshRadar.id)).not.toBeNull();
    expect(db.getArticle(keptArticle.id)).not.toBeNull();
  });
});

describe('openDb on disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hootradar-db-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the parent directory, uses WAL and persists across reopen', () => {
    const file = join(dir, 'nested', 'deeper', 'hootradar.db');
    const first = openDb(file);
    const a = article();
    first.insertArticle(a);
    first.close();

    expect(existsSync(file)).toBe(true);
    const raw = new DatabaseSync(file);
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    raw.close();

    const second = openDb(file);
    expect(second.getArticle(a.id)).toEqual(a);
    second.close();
  });
});
