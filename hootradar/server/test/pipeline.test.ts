import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QUANT_DISCLAIMER,
  type DetectionEvent,
  type MarketRegime,
  type NewsArticle,
  type QuantResult,
  type TokenSnapshot,
} from '../../shared/types.js';
import type { ChainAdapter, ChainConfig, TokenEnrichment } from '../src/chains/types.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/db.js';
import { Bus } from '../src/engine/bus.js';
import { Pipeline, type PipelineDeps } from '../src/engine/pipeline.js';
import { parseGtTokenInfo } from '../src/sources/geckoterminal.js';

// Keep the test hermetic: the real quant matcher and AI writer are replaced by the injected stubs below.
vi.mock('../src/quant/matcher.js', () => ({
  matchQuant: () => {
    throw new Error('real matchQuant must not be used in this test');
  },
}));
vi.mock('../src/ai/newswriter.js', () => ({
  writeArticle: () => {
    throw new Error('real writeArticle must not be used in this test');
  },
}));

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 1, 21, 10);
const ADDRESS = '6nyVgjjPGY9c7QpjMUPY8vS6sLzVoiq9VyxYoTvmpump';
const OTHER_ADDRESS = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WRITE_MS = 1500;

const SOLANA: ChainConfig = {
  id: 'solana',
  name: 'Solana',
  short: 'SOL',
  nativeSymbol: 'SOL',
  color: '#b18cff',
  geckoNetwork: 'solana',
  dexscreenerChainId: 'solana',
  explorerTokenUrl: (a) => `https://solscan.io/token/${a}`,
  addressPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  caseInsensitiveAddress: false,
};

const REGIME: MarketRegime = { label: 'risk-on', breadthPct: 64, medianH1ChangePct: 3.2, sampleSize: 120, computedAt: T0 };

/** Real GeckoTerminal token-info response (holders, top-10 share, security flags). */
const ENRICHMENT = parseGtTokenInfo(
  JSON.parse(readFileSync(new URL('./fixtures/gt_token_info_bonk.json', import.meta.url), 'utf8')),
) as TokenEnrichment;

type WriterInput = Parameters<NonNullable<PipelineDeps['writer']>>[0];

/**
 * Market snapshot shaped like a token in the middle of a pump (scores were
 * calibrated against the real deriveMetrics + detectAnomalies):
 *   watch()    → 49 WATCH
 *   alert()    → 66 ALERT
 *   breaking() → 72, or 80 BREAKING with ≥15 social mentions
 */
function pumping(o: { buyShare: number; buyersM5: number; priceH1: number }, over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  const buysM5 = Math.round(300 * o.buyShare);
  return {
    chain: 'solana',
    address: ADDRESS,
    symbol: 'OWL',
    name: 'Night Owl',
    pairAddress: 'JEAR6z8whbYFGrAJ4iDUE6GjrJwZRy8EaxwZf7jG2FkE',
    dex: 'pump-fun',
    ts: T0,
    priceUsd: 0.0123,
    marketCapUsd: null,
    fdvUsd: 900_000,
    liquidityUsd: 80_000,
    volumeUsd: { m5: 30_000, h1: 60_000, h24: 60_000 },
    priceChangePct: { m5: o.priceH1 / 3, h1: o.priceH1, h6: o.priceH1 * 1.3 },
    txns: {
      m5: { buys: buysM5, sells: 300 - buysM5, buyers: o.buyersM5, sellers: 20 },
      h1: { buys: 400, sells: 200, buyers: 200, sellers: 80 },
    },
    holders: null,
    top10HolderPct: null,
    createdAt: T0 - 3 * HOUR,
    imageUrl: 'https://ipfs.io/ipfs/owl.png',
    links: [
      { type: 'website', url: 'https://owl.example' },
      { type: 'twitter', url: 'https://x.com/owl' },
      { type: 'telegram', url: 'https://t.me/owl' },
    ],
    security: null,
    sources: ['geckoterminal', 'dexscreener'],
    boosted: false,
    ...over,
  };
}
const cold = (over: Partial<TokenSnapshot> = {}) => pumping({ buyShare: 0.5, buyersM5: 0, priceH1: 0 }, { volumeUsd: { m5: 500, h1: 60_000 }, ...over });
const nearWatch = (over: Partial<TokenSnapshot> = {}) => pumping({ buyShare: 0.5, buyersM5: 50, priceH1: 0 }, over);
const watch = (over: Partial<TokenSnapshot> = {}) => pumping({ buyShare: 0.5, buyersM5: 70, priceH1: 15 }, over);
const alert = (over: Partial<TokenSnapshot> = {}) => pumping({ buyShare: 2 / 3, buyersM5: 100, priceH1: 60 }, over);
const breaking = (over: Partial<TokenSnapshot> = {}) => pumping({ buyShare: 0.9, buyersM5: 100, priceH1: 60 }, over);

function quantResult(): QuantResult {
  return { top: null, matches: [], regime: REGIME, riskFlags: ['Liquidity under $100k'], disclaimer: QUANT_DISCLAIMER };
}

function draftFor(i: WriterInput) {
  return {
    headline: `${i.snapshot.symbol} trading accelerates`,
    lede: `Score ${i.detection.score}.`,
    aiLine: 'Activity is accelerating.',
    whyItMatters: ['one', 'two', 'three'],
    quantAnalysis: 'Resembles a breakout.',
    outlook: { bullish: 'b', neutral: 'n', risk: 'r' },
    engine: 'rules' as const,
    model: null,
    lang: i.lang,
  };
}

interface HarnessOpts {
  config?: Partial<AppConfig>;
  enrich?: ChainAdapter['enrich'];
  mentions?: (s: TokenSnapshot) => Promise<number | null>;
}

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function harness(o: HarnessOpts = {}) {
  const db = openDb(':memory:');
  open.push(db);
  const bus = new Bus();
  const articles: NewsArticle[] = [];
  const detections: DetectionEvent[] = [];
  bus.on('article', (a) => articles.push(a));
  bus.on('detection', (e) => detections.push(e));

  const config: AppConfig = { ...loadConfig({ CHAINS: 'solana', NEWS_LANG: 'en' }), ...o.config };
  let t = T0;
  const enrich = vi.fn(o.enrich ?? (async () => ENRICHMENT));
  const adapter: ChainAdapter = {
    config: SOLANA,
    discover: vi.fn(async () => []),
    refresh: vi.fn(async () => []),
    enrich,
    lookup: vi.fn(async () => null),
    isAddress: (q) => SOLANA.addressPattern.test(q),
    normalizeAddress: (a) => a,
  };
  const quant = vi.fn(quantResult);
  const writer = vi.fn(async (i: WriterInput) => {
    t += WRITE_MS;
    return draftFor(i);
  });
  const enqueue = vi.fn((_a: NewsArticle) => []);
  const mentions = o.mentions ? vi.fn(o.mentions) : undefined;

  const pipeline = new Pipeline({
    db,
    bus,
    config,
    adapters: [adapter],
    distribution: { enqueue } as unknown as PipelineDeps['distribution'],
    regime: () => REGIME,
    mentions,
    quant,
    writer,
    now: () => t,
  });

  /** Mimics the scanner: store the snapshot observed at T0+offset, then process it. */
  async function at(offsetMs: number, s: TokenSnapshot): Promise<void> {
    t = T0 + offsetMs;
    const observed = { ...s, ts: t };
    db.insertSnapshot(observed);
    await pipeline.process(observed, t);
  }

  return { db, articles, detections, enrich, quant, writer, enqueue, mentions, pipeline, at };
}

describe('below threshold', () => {
  it('ignores quiet tokens without spending provider calls', async () => {
    const h = harness({ mentions: async () => 2 });
    await h.at(0, cold());
    expect(h.detections).toEqual([]);
    expect(h.db.recentDetections(10)).toEqual([]);
    expect(h.mentions).not.toHaveBeenCalled(); // social attention could not lift it to WATCH
    expect(h.enrich).not.toHaveBeenCalled();
    expect(h.writer).not.toHaveBeenCalled();
  });

  it('asks for social mentions only when they could reach WATCH, and uses them', async () => {
    const quiet = harness({ mentions: async () => null });
    await quiet.at(0, nearWatch()); // 42 on market data alone
    expect(quiet.mentions).toHaveBeenCalledTimes(1);
    expect(quiet.detections).toEqual([]);

    const talked = harness({ mentions: async () => 15 });
    await talked.at(0, nearWatch());
    expect(talked.detections).toHaveLength(1);
    expect(talked.detections[0]?.severity).toBe('WATCH');
    expect(talked.detections[0]?.signals.map((s) => s.code)).toContain('social_attention');
  });

  it('a failing mentions lookup degrades to "unknown"', async () => {
    const h = harness({ mentions: async () => Promise.reject(new Error('hn down')) });
    await expect(h.at(0, nearWatch())).resolves.toBeUndefined();
    expect(h.detections).toEqual([]);
  });
});

describe('WATCH', () => {
  it('stores a detection event without enriching or writing, at most once per 10 minutes', async () => {
    const h = harness();
    await h.at(0, watch());

    expect(h.detections).toHaveLength(1);
    const e = h.detections[0];
    expect(e).toMatchObject({ chain: 'solana', address: ADDRESS, symbol: 'OWL', severity: 'WATCH', articleId: null, ts: T0 });
    expect(e?.score).toBeGreaterThanOrEqual(45);
    expect(e?.score).toBeLessThan(62);
    expect(h.db.recentDetections(10)).toEqual([e]);
    expect(h.enrich).not.toHaveBeenCalled();
    expect(h.writer).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.articles).toEqual([]);

    await h.at(2 * MIN, watch());
    expect(h.db.recentDetections(10)).toHaveLength(1);

    await h.at(11 * MIN, watch());
    expect(h.db.recentDetections(10)).toHaveLength(2);
    expect(h.detections).toHaveLength(2);
  });
});

describe('ALERT → article', () => {
  it('enriches, scores, writes, stores, distributes and emits a complete article', async () => {
    const h = harness();
    await h.at(0, alert());

    expect(h.enrich).toHaveBeenCalledWith(ADDRESS);
    expect(h.quant).toHaveBeenCalledTimes(1);
    expect(h.writer).toHaveBeenCalledTimes(1);
    const input = h.writer.mock.calls[0]?.[0];
    expect(input?.lang).toBe('en');
    expect(input?.previous).toBeNull();
    expect(input?.snapshot.holders).toBe(ENRICHMENT.holders); // writer sees enriched data
    expect(input?.quant.regime).toEqual(REGIME);

    expect(h.articles).toHaveLength(1);
    const a = h.articles[0] as NewsArticle;
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).toMatchObject({
      chain: 'solana',
      address: ADDRESS,
      symbol: 'OWL',
      name: 'Night Owl',
      imageUrl: 'https://ipfs.io/ipfs/owl.png',
      severity: 'ALERT',
      score: 66,
      headline: 'OWL trading accelerates',
      engine: 'rules',
      model: null,
      lang: 'en',
      updateOf: null,
      createdAt: T0 + WRITE_MS,
      links: {
        dexscreener: `https://dexscreener.com/solana/${ADDRESS}`,
        explorer: `https://solscan.io/token/${ADDRESS}`,
        website: 'https://owl.example',
        twitter: 'https://x.com/owl',
        telegram: 'https://t.me/owl',
      },
      quant: { top: null, matches: [], regime: REGIME, riskFlags: ['Liquidity under $100k'] },
    });
    expect(a.quant).not.toHaveProperty('disclaimer');
    expect(a.signals.map((s) => s.code)).toEqual(
      expect.arrayContaining(['volume_surge', 'tx_acceleration', 'buyer_surge', 'momentum']),
    );
    expect(a.metrics).toMatchObject({
      priceUsd: 0.0123,
      marketCapUsd: 900_000,
      mcIsFdv: true,
      liquidityUsd: 80_000,
      volumeUsd: 60_000,
      volumeWindow: 'h1',
      txPerMin: 60,
      holders: ENRICHMENT.holders,
      holdersGrowthPct: null,
      priceChangeH1Pct: 60,
    });
    expect(a.pipeline).toEqual({
      detectedAt: T0,
      analyzedAt: T0,
      quantAt: T0,
      writtenAt: T0 + WRITE_MS,
      publishedAt: T0 + WRITE_MS,
    });

    expect(h.db.getArticle(a.id)).toEqual(a);
    expect(h.enqueue).toHaveBeenCalledWith(a);
    expect(h.detections).toHaveLength(1);
    expect(h.detections[0]).toMatchObject({ severity: 'ALERT', score: 66, articleId: a.id });
    expect(h.db.lastDetectionFor('solana', ADDRESS)?.articleId).toBe(a.id);
  });

  it('keeps freshly enriched holder data in the token history', async () => {
    const h = harness();
    await h.at(0, alert());
    const history = h.db.history('solana', ADDRESS, 0);
    expect(history.map((s) => s.holders)).toEqual([null, ENRICHMENT.holders]);
    expect(history[1]?.security).toEqual(ENRICHMENT.security);
  });

  it('publishes without holder data when enrichment fails', async () => {
    const h = harness({ enrich: async () => Promise.reject(new Error('GT 429')) });
    await h.at(0, alert());
    expect(h.articles).toHaveLength(1);
    expect(h.articles[0]?.metrics.holders).toBeNull();
  });

  it('enrichment can escalate the story (holder growth across our own history)', async () => {
    const h = harness();
    h.db.insertSnapshot({ ...alert(), ts: T0 - 20 * MIN, holders: Math.round((ENRICHMENT.holders ?? 0) / 2) });
    await h.at(0, alert());
    const a = h.articles[0];
    expect(a?.severity).toBe('BREAKING');
    expect(a?.metrics.holdersGrowthPct).toBeCloseTo(100, 0);
    expect(a?.signals.find((s) => s.code === 'holder_growth')?.label).toBe('+100% holders / 20m');
  });
});

describe('cooldown and follow-ups', () => {
  it('suppresses a repeat of the same story inside the cooldown and allows a new one after it', async () => {
    const h = harness();
    await h.at(0, alert());
    await h.at(5 * MIN, alert());
    await h.at(20 * MIN, alert());

    expect(h.articles).toHaveLength(1);
    expect(h.writer).toHaveBeenCalledTimes(1);
    expect(h.enrich).toHaveBeenCalledTimes(1); // no enrichment spent on a suppressed article
    // 5 min: deduped (same score, < 10 min) · 20 min: recorded as activity without an article
    expect(h.db.recentDetections(10).map((e) => e.articleId != null)).toEqual([false, true]);

    await h.at(31 * MIN, alert());
    expect(h.articles).toHaveLength(2);
    expect(h.articles[1]?.updateOf).toBeNull();
    expect(h.writer.mock.calls[1]?.[0].previous).toBeNull();
  });

  it('publishes an escalation ALERT → BREAKING inside the cooldown as a follow-up', async () => {
    let mentions: number | null = null;
    const h = harness({ mentions: async () => mentions });
    await h.at(0, alert());
    const first = h.articles[0] as NewsArticle;

    mentions = 15;
    await h.at(2 * MIN, breaking());

    expect(h.articles).toHaveLength(2);
    const followUp = h.articles[1] as NewsArticle;
    expect(followUp.severity).toBe('BREAKING');
    expect(followUp.score).toBe(80);
    expect(followUp.updateOf).toBe(first.id);
    expect(h.writer.mock.calls[1]?.[0].previous?.id).toBe(first.id);
    expect(h.enrich).toHaveBeenCalledTimes(1); // second article reused the 3-minute enrichment cache
    expect(h.db.lastArticleFor('solana', ADDRESS)?.id).toBe(followUp.id);
  });

  it('allows a same-severity follow-up only when the score jumps by at least 15', async () => {
    // BREAKING out of reach so both articles stay ALERT
    const thresholds = { WATCH: 45, ALERT: 62, BREAKING: 95 };
    const run = async (firstStory: TokenSnapshot) => {
      let mentions: number | null = null;
      const h = harness({ mentions: async () => mentions, config: { thresholds } });
      await h.at(0, firstStory);
      mentions = 15;
      await h.at(5 * MIN, breaking()); // 80
      return h.articles;
    };

    const plus14 = await run(alert()); // 66 → 80
    expect(plus14.map((a) => a.score)).toEqual([66]);

    const plus16 = await run(pumping({ buyShare: 0.5, buyersM5: 100, priceH1: 60 })); // 64 → 80
    expect(plus16.map((a) => [a.severity, a.score])).toEqual([
      ['ALERT', 64],
      ['ALERT', 80],
    ]);
    expect(plus16[1]?.updateOf).toBe(plus16[0]?.id);
  });
});

describe('safety rails', () => {
  it('never publishes a honeypot revealed by enrichment', async () => {
    const honeypot: TokenEnrichment = { ...ENRICHMENT, security: { ...ENRICHMENT.security!, honeypot: 'yes' } };
    const h = harness({ enrich: async () => honeypot });
    await h.at(0, alert());
    expect(h.writer).not.toHaveBeenCalled();
    expect(h.articles).toEqual([]);
    expect(h.detections).toEqual([]);
  });

  it('never publishes a token already known to be a honeypot', async () => {
    const h = harness();
    await h.at(0, alert({ security: { mintAuthority: false, freezeAuthority: false, honeypot: 'yes', devHoldingPct: null } }));
    expect(h.enrich).not.toHaveBeenCalled();
    expect(h.articles).toEqual([]);
    expect(h.detections).toEqual([]);
  });

  it('with autopublish off stores detection events only', async () => {
    const h = harness({ config: { autopublish: false } });
    await h.at(0, watch());
    await h.at(MIN, alert()); // +17 over the WATCH score → not deduped
    await h.at(2 * MIN, alert()); // same score within 10 min → deduped

    expect(h.articles).toEqual([]);
    expect(h.writer).not.toHaveBeenCalled();
    expect(h.enrich).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.db.recentDetections(10).map((e) => [e.severity, e.articleId])).toEqual([
      ['ALERT', null],
      ['WATCH', null],
    ]);
  });

  it('enforces the global hourly article cap', async () => {
    const h = harness({ config: { maxArticlesPerHour: 1 } });
    await h.at(0, alert());
    await h.at(MIN, alert({ address: OTHER_ADDRESS, symbol: 'BONK' }));

    expect(h.articles.map((a) => a.symbol)).toEqual(['OWL']);
    expect(h.db.lastDetectionFor('solana', OTHER_ADDRESS)).toMatchObject({ severity: 'ALERT', articleId: null });
  });

  it('never writes two articles for the same token at once', async () => {
    const h = harness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    h.writer.mockImplementationOnce(async (i) => {
      await gate;
      return draftFor(i);
    });

    const s = { ...alert(), ts: T0 };
    h.db.insertSnapshot(s);
    const first = h.pipeline.process(s, T0);
    const second = h.pipeline.process(s, T0);
    await second;
    expect(h.articles).toEqual([]);
    release();
    await first;

    expect(h.articles).toHaveLength(1);
    expect(h.writer).toHaveBeenCalledTimes(1);
  });

  it('never throws, and recovers after a failure', async () => {
    const h = harness();
    h.writer.mockImplementationOnce(async () => {
      throw new Error('writer exploded');
    });
    await expect(h.at(0, alert())).resolves.toBeUndefined();
    expect(h.articles).toEqual([]);

    h.quant.mockImplementationOnce(() => {
      throw new Error('quant exploded');
    });
    await expect(h.at(MIN, alert())).resolves.toBeUndefined();
    expect(h.articles).toEqual([]);

    await h.at(2 * MIN, alert());
    expect(h.articles).toHaveLength(1);
  });

  it('a distribution failure does not stop the article from going live', async () => {
    const h = harness();
    h.enqueue.mockImplementationOnce(() => {
      throw new Error('queue full');
    });
    await h.at(0, alert());
    expect(h.articles).toHaveLength(1);
    expect(h.db.getArticle(h.articles[0]?.id ?? '')).not.toBeNull();
  });
});
