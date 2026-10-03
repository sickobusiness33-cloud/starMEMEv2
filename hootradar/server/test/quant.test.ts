import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  QUANT_DISCLAIMER,
  type DerivedMetrics,
  type MarketRegime,
  type QuantFamily,
  type QuantResult,
  type TokenSnapshot,
} from '../../shared/types.js';
import { deriveMetrics } from '../src/engine/metrics.js';
import { parseDsPairs } from '../src/sources/dexscreener.js';
import { parseGtPools } from '../src/sources/geckoterminal.js';
import { computeLeaders, MIN_LEADER_SCORE } from '../src/quant/leaders.js';
import { BUILTIN_QUANT_SOURCE, METHODOLOGIES, SOURCE_POLICY } from '../src/quant/library.js';
import { matchQuant, ramp, SIGNATURE_IDS } from '../src/quant/matcher.js';
import { computeRegime, MIN_REGIME_SAMPLE } from '../src/quant/regime.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 1, 21, 10);

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

let seq = 0;
function snap(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  seq += 1;
  return {
    chain: 'solana',
    address: `Tok${seq}`,
    symbol: `T${seq}`,
    name: `Token ${seq}`,
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
    sources: [],
    boosted: false,
    ...over,
  };
}

const NULL_METRICS: DerivedMetrics = {
  ageMinutes: null,
  txPerMin: null,
  txAcceleration: null,
  volumeAcceleration: null,
  buyPct: null,
  sellPct: null,
  buySellWindow: null,
  uniqueBuyersM5: null,
  buyerAcceleration: null,
  holdersGrowthPct: null,
  holdersGrowthWindowMin: null,
  liquidityChangePct: null,
  momentumScore: null,
  volatilityProxy: null,
  avgTradeUsd: null,
  largeWalletFlow: null,
  volumeToLiquidity: null,
  illiquidity: null,
};
const metrics = (over: Partial<DerivedMetrics> = {}): DerivedMetrics => ({ ...NULL_METRICS, ...over });

const UNKNOWN_REGIME: MarketRegime = { label: 'unknown', breadthPct: null, medianH1ChangePct: null, sampleSize: 0, computedAt: T0 };
const NEUTRAL_REGIME: MarketRegime = { label: 'neutral', breadthPct: 50, medianH1ChangePct: 1, sampleSize: 40, computedAt: T0 };
const RISK_ON_REGIME: MarketRegime = { label: 'risk-on', breadthPct: 68, medianH1ChangePct: 6, sampleSize: 40, computedAt: T0 };

const CLEAN_SECURITY = { mintAuthority: false, freezeAuthority: false, honeypot: 'no', devHoldingPct: 1 } as const;

/** A token rallying steadily on every horizon. */
const momentumToken = () =>
  snap({
    symbol: 'RALLY',
    priceChangePct: { m5: 4, h1: 34, h6: 61, h24: 80 },
    volumeUsd: { m5: 15_000, h1: 150_000, h24: 400_000 },
    liquidityUsd: 85_000,
    marketCapUsd: 900_000,
    top10HolderPct: 22,
    security: { ...CLEAN_SECURITY },
  });
const momentumMetrics = () =>
  metrics({
    ageMinutes: 300,
    txPerMin: 6,
    txAcceleration: 1.1,
    volumeAcceleration: 1.2,
    buyPct: 54,
    sellPct: 46,
    buySellWindow: 'm5',
    uniqueBuyersM5: 12,
    buyerAcceleration: 1.1,
    holdersGrowthPct: 1,
    holdersGrowthWindowMin: 30,
    liquidityChangePct: 4,
    momentumScore: 76.6,
    volatilityProxy: 8.2,
    volumeToLiquidity: 4.7,
    illiquidity: 22,
  });

/** A token collapsing on every horizon with sellers in control and liquidity leaving. */
const dumpToken = () =>
  snap({
    symbol: 'DUMP',
    priceChangePct: { m5: -6, h1: -45, h6: -60, h24: -55 },
    volumeUsd: { m5: 30_000, h1: 400_000, h24: 900_000 },
    liquidityUsd: 30_000,
    marketCapUsd: 250_000,
    top10HolderPct: 55,
    security: { ...CLEAN_SECURITY },
  });
const dumpMetrics = () =>
  metrics({
    ageMinutes: 600,
    txPerMin: 8,
    txAcceleration: 1.2,
    volumeAcceleration: 1.5,
    buyPct: 30,
    sellPct: 70,
    buySellWindow: 'm5',
    liquidityChangePct: -25,
    momentumScore: -83,
    volatilityProxy: 10.6,
    volumeToLiquidity: 30,
    illiquidity: 112.5,
  });

const scoreOf = (r: QuantResult, id: string): number => r.matches.find((m) => m.methodologyId === id)?.score ?? 0;

function expectWellFormed(r: QuantResult): void {
  expect(r.disclaimer).toBe(QUANT_DISCLAIMER);
  expect(r.top).toEqual(r.matches[0] ?? null);
  for (let i = 1; i < r.matches.length; i++) {
    expect(r.matches[i - 1]!.score).toBeGreaterThanOrEqual(r.matches[i]!.score);
  }
  for (const m of r.matches) {
    expect(Number.isInteger(m.score)).toBe(true);
    expect(m.score).toBeGreaterThan(0);
    expect(m.score).toBeLessThanOrEqual(100);
    expect(m.coverage).toBeGreaterThan(0);
    expect(m.coverage).toBeLessThanOrEqual(1);
    expect(m.rationale).toMatch(/^Current conditions .+\.$/);
    expect(m.rationale).not.toMatch(/NaN|Infinity|undefined|null/);
    for (const f of m.factors) {
      expect(Number.isNaN(f.fit)).toBe(false);
      expect(f.fit).toBeGreaterThanOrEqual(0);
      expect(f.fit).toBeLessThanOrEqual(1);
      if (f.value != null) expect(Number.isFinite(f.value)).toBe(true);
    }
  }
  for (const flag of r.riskFlags) expect(flag).not.toMatch(/NaN|Infinity|undefined/);
}

/* ───────────────────────────── library ───────────────────────────── */

describe('methodology library', () => {
  it('has 10-12 methodologies with unique ids, each backed by a matcher signature', () => {
    expect(METHODOLOGIES.length).toBeGreaterThanOrEqual(10);
    expect(METHODOLOGIES.length).toBeLessThanOrEqual(12);
    const ids = METHODOLOGIES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...SIGNATURE_IDS].sort()).toEqual([...ids].sort());
  });

  it('covers every required family', () => {
    const families = new Set(METHODOLOGIES.map((m) => m.family));
    const required: QuantFamily[] = [
      'momentum',
      'trend',
      'breakout',
      'mean_reversion',
      'volatility',
      'liquidity',
      'order_flow',
      'attention',
      'regime',
      'risk',
    ];
    for (const f of required) expect(families.has(f)).toBe(true);
  });

  it('fills every field and cites at least one paper over https', () => {
    for (const m of METHODOLOGIES) {
      expect(m.name.length).toBeGreaterThan(3);
      expect(m.summary.length).toBeGreaterThan(40);
      expect(m.howItWorks.length).toBeGreaterThanOrEqual(2);
      expect(m.howItWorks.length).toBeLessThanOrEqual(4);
      expect(m.signature.length).toBeGreaterThan(20);
      expect(m.cryptoAdaptation.length).toBeGreaterThan(40);
      expect(m.horizon.length).toBeGreaterThan(3);
      expect(m.caveats.length).toBeGreaterThanOrEqual(2);
      expect(m.references.length).toBeGreaterThanOrEqual(1);
      expect(m.references.some((r) => r.kind === 'paper')).toBe(true);
      for (const ref of m.references) {
        expect(new URL(ref.url).protocol).toBe('https:');
        expect(ref.label.length).toBeGreaterThan(5);
        if (ref.kind === 'quantpedia') expect(new URL(ref.url).hostname).toBe('quantpedia.com');
      }
    }
  });

  it('links every paper its own description names (author and year)', () => {
    // live: Faber (2007), Gervais et al. (2001), Da et al. (2011)… were named without a link
    const cited = /([A-Z][\p{L}-]+)(?:,\s[A-Z][\p{L}-]+)*(?:\s&\s[A-Z][\p{L}-]+)?\s\((\d{4})\)/gu;
    for (const m of METHODOLOGIES) {
      for (const [, author, year] of m.howItWorks.join(' ').matchAll(cited)) {
        const linked = m.references.some((r) => r.kind === 'paper' && r.label.includes(author!) && r.label.includes(year!));
        expect(linked, `${m.id}: ${author} (${year})`).toBe(true);
      }
    }
  });

  it('states the source policy and exposes the built-in library as a QuantSource', async () => {
    expect(SOURCE_POLICY).toMatch(/Quantpedia/);
    expect(SOURCE_POLICY).toMatch(/scrape/);
    expect(SOURCE_POLICY).toMatch(/own words/);
    expect(SOURCE_POLICY).toMatch(/licensed Quantpedia Pro feed/);
    // user-facing copy: no code signatures
    expect(SOURCE_POLICY).not.toMatch(/Promise<|load\(\)/);
    await expect(BUILTIN_QUANT_SOURCE.load()).resolves.toBe(METHODOLOGIES);
  });
});

/* ───────────────────────────── matcher ───────────────────────────── */

describe('ramp', () => {
  it('is a smooth, clamped 0-1 transition in either direction', () => {
    expect(ramp(-5, 0, 10)).toBe(0);
    expect(ramp(5, 0, 10)).toBe(0.5);
    expect(ramp(15, 0, 10)).toBe(1);
    expect(ramp(0.4, 1, 0.4)).toBe(1);
    expect(ramp(1.2, 1, 0.4)).toBe(0);
    expect(ramp(2.5, 0, 10)).toBeCloseTo(0.15625, 6);
  });
});

describe('matchQuant', () => {
  it('ranks momentum and trend first for a steady multi-horizon rally', () => {
    const r = matchQuant(momentumToken(), momentumMetrics(), NEUTRAL_REGIME);
    expectWellFormed(r);
    expect(r.top?.methodologyId).toBe('ts-momentum');
    expect(r.top?.score).toBe(100);
    expect(scoreOf(r, 'trend-following')).toBe(100);
    // 300 minutes old: the 24h window is not real yet, so the size factor is judged without it.
    expect(scoreOf(r, 'crypto-size-momentum')).toBe(93);
    expect(r.matches.find((m) => m.methodologyId === 'crypto-size-momentum')?.factors.find((f) => f.feature === 'priceChangeH24')?.value).toBeNull();
    expect(scoreOf(r, 'regime-filter')).toBe(54);
    expect(r.top?.rationale).toBe(
      'Current conditions resemble the setup that time-series momentum looks for: price up 34% over 1h and 61% over 6h, with aligned short-term trend (+4% over 5m).',
    );
    expect(scoreOf(r, 'short-term-reversal')).toBeLessThan(15);
    expect(scoreOf(r, 'risk-overlay')).toBeLessThan(15);
    expect(r.riskFlags).toEqual([]);
  });

  it('ranks the risk overlay first for a dumping token and drops the long-side setups', () => {
    const r = matchQuant(dumpToken(), dumpMetrics(), NEUTRAL_REGIME);
    expectWellFormed(r);
    expect(['risk', 'mean_reversion']).toContain(r.top?.family);
    expect(r.top?.methodologyId).toBe('risk-overlay');
    expect(r.top?.score).toBe(75);
    for (const id of ['ts-momentum', 'trend-following', 'volume-breakout', 'order-flow-imbalance', 'crypto-size-momentum']) {
      expect(scoreOf(r, id)).toBe(0);
    }
    expect(scoreOf(r, 'short-term-reversal')).toBe(12);
    expect(r.top?.rationale).toBe(
      'Current conditions resemble what a drawdown and position-sizing overlay reacts to: a 60% drop over 6h, liquidity down 25% in our recent snapshots, 70% of transactions being sells, top-10 holders owning 55% of supply — conditions in which sizing rules cut exposure to a minimum.',
    );
    expect(r.riskFlags).toEqual(['Top-10 holders own 55% of supply', 'Volume is 30x liquidity (wash-trading risk)']);
  });

  it('sees a reversal setup when an extreme hour starts to snap back on fading activity', () => {
    const s = snap({ priceChangePct: { m5: -9, h1: 120, h6: 140 } });
    const r = matchQuant(s, metrics({ txAcceleration: 0.4, volumeAcceleration: 0.5 }), UNKNOWN_REGIME);
    expectWellFormed(r);
    expect(r.top?.methodologyId).toBe('short-term-reversal');
    expect(r.top?.rationale).toContain('an extreme 1h rise of 120%');
    expect(r.top?.rationale).toContain('a 5m counter-move of -9%');
    expect(r.top?.rationale).toContain('trading slowing to 0.4x the hourly pace');
  });

  it('returns no matches when every input is unknown', () => {
    const r = matchQuant(snap(), metrics(), UNKNOWN_REGIME);
    expectWellFormed(r);
    expect(r.matches).toEqual([]);
    expect(r.top).toBeNull();
    expect(r.riskFlags).toEqual(['Honeypot status unknown']);
  });

  it('excludes missing features from the denominator but caps the score by coverage', () => {
    // Only volume acceleration known: fit 1 on 3 of the breakout signature's 8 weight units.
    const r = matchQuant(snap(), metrics({ volumeAcceleration: 6 }), UNKNOWN_REGIME);
    expectWellFormed(r);
    const breakout = r.matches.find((m) => m.methodologyId === 'volume-breakout');
    expect(breakout?.coverage).toBe(0.38);
    expect(breakout?.score).toBe(63); // 100 × 1 × (0.375 / 0.6)
    const missing = breakout?.factors.filter((f) => f.value == null).map((f) => f.feature);
    expect(missing).toEqual(['txAcceleration', 'priceChangeM5', 'priceChangeH1']);
  });

  it('turns social mentions and buyer bursts into an attention match', () => {
    const s = snap({ boosted: true });
    const m = metrics({ buyerAcceleration: 3.5, uniqueBuyersM5: 60, holdersGrowthPct: 25, holdersGrowthWindowMin: 18 });
    const r = matchQuant(s, m, UNKNOWN_REGIME, { socialMentions: 12 });
    expectWellFormed(r);
    expect(r.top?.methodologyId).toBe('investor-attention');
    expect(r.top?.score).toBe(100);
    expect(r.top?.rationale).toBe(
      'Current conditions resemble the setup that investor-attention research looks for: 12 recent mentions in public news and forums, unique buyers arriving at 3.5x the hourly pace, holders up 25% in 18 min, a paid DexScreener boost.',
    );
    expect(r.riskFlags).toContain('Boosted listing (paid promotion)');
  });

  it('only matches the regime filter on a known regime, and only for a token above its earlier price', () => {
    const s = snap({ priceChangePct: { h1: 15, h6: 30 } });
    const on = matchQuant(s, metrics(), RISK_ON_REGIME);
    expect(scoreOf(on, 'regime-filter')).toBe(84);
    expect(on.matches.find((m) => m.methodologyId === 'regime-filter')?.rationale).toBe(
      'Current conditions resemble the conditions a market-regime trend filter looks for: a risk-on market (68% of tracked tokens up over 1h, median +6%), the token above its price 6h ago (+30%).',
    );
    expect(scoreOf(matchQuant(s, metrics(), UNKNOWN_REGIME), 'regime-filter')).toBe(0);
    const falling = snap({ priceChangePct: { h1: -15, h6: -30 } });
    expect(scoreOf(matchQuant(falling, metrics(), RISK_ON_REGIME), 'regime-filter')).toBe(0);
  });

  it('ignores windows longer than the token has existed', () => {
    // GeckoTerminal reports the whole life of a 10-minute-old token in every window.
    const s = snap({ priceChangePct: { m5: 20, m15: 80, m30: 80, h1: 80, h6: 80, h24: 80 } });
    const r = matchQuant(s, metrics({ ageMinutes: 10, momentumScore: 70, volatilityProxy: 60 }), NEUTRAL_REGIME);
    expectWellFormed(r);
    // No real 1h history yet: lookback methodologies cannot be judged at all.
    expect(scoreOf(r, 'ts-momentum')).toBe(0);
    expect(scoreOf(r, 'trend-following')).toBe(0);
    for (const m of r.matches) {
      expect(m.rationale).not.toMatch(/over (1h|6h|24h)/);
      for (const f of m.factors.filter((x) => /H1$|H6$|H24$/.test(x.feature))) expect(f.value).toBeNull();
    }
    expect(scoreOf(r, 'volatility-managed')).toBeGreaterThan(0); // the 5m swing is real
  });

  it('still sees a drawdown since launch on a token younger than the windows', () => {
    const s = snap({ priceChangePct: { m5: -30, h1: -82, h6: -82, h24: -82 }, liquidityUsd: 4_000 });
    const r = matchQuant(s, metrics({ ageMinutes: 12, sellPct: 80, buyPct: 20, liquidityChangePct: -60 }), UNKNOWN_REGIME);
    expectWellFormed(r);
    expect(r.top?.methodologyId).toBe('risk-overlay');
    expect(r.top?.rationale).toContain('an 82% drop since launch');
    expect(r.riskFlags).toEqual(['Honeypot status unknown', 'Liquidity under $10k', 'Token younger than 15 minutes']);
  });

  it('raises every structural risk flag it can see', () => {
    const s = snap({
      liquidityUsd: 6_000,
      top10HolderPct: 72.4,
      boosted: true,
      security: { mintAuthority: true, freezeAuthority: true, honeypot: 'unknown', devHoldingPct: 14 },
    });
    const r = matchQuant(s, metrics({ ageMinutes: 9, volumeToLiquidity: 34 }), UNKNOWN_REGIME);
    expect(r.riskFlags).toEqual([
      'Mint authority enabled',
      'Freeze authority enabled',
      'Honeypot status unknown',
      'Liquidity under $10k',
      'Top-10 holders own 72% of supply',
      'Developer holds 14% of supply',
      'Token younger than 15 minutes',
      'Volume is 34x liquidity (wash-trading risk)',
      'Boosted listing (paid promotion)',
    ]);
    expect(matchQuant(snap({ security: { ...CLEAN_SECURITY, honeypot: 'yes' } }), metrics(), UNKNOWN_REGIME).riskFlags).toEqual([
      'Honeypot detected',
    ]);
  });

  it('never counts an unknown honeypot status as a security red flag', () => {
    const factorOf = (security: TokenSnapshot['security']) =>
      matchQuant(snap({ security, priceChangePct: { m5: -30, h1: -82, h6: -82 } }), metrics({ ageMinutes: 300, sellPct: 80, buyPct: 20 }), UNKNOWN_REGIME)
        .matches.concat()
        .find((m) => m.methodologyId === 'risk-overlay')
        ?.factors.find((f) => f.feature === 'securityRedFlags')?.value;
    const r = matchQuant(
      snap({ priceChangePct: { m5: -30, h1: -82, h6: -82 }, security: { ...CLEAN_SECURITY, honeypot: 'unknown' } }),
      metrics({ ageMinutes: 300, sellPct: 80, buyPct: 20 }),
      UNKNOWN_REGIME,
    );
    expect(r.matches.find((m) => m.methodologyId === 'risk-overlay')?.rationale).not.toMatch(/security red flag/);
    expect(r.riskFlags).toContain('Honeypot status unknown'); // reported honestly as unknown instead
    // nothing known at all: missing data, not zero flags
    expect(factorOf({ mintAuthority: null, freezeAuthority: null, honeypot: 'unknown', devHoldingPct: null }) ?? null).toBeNull();
    expect(factorOf({ ...CLEAN_SECURITY, honeypot: 'unknown' })).toBe(0);
    expect(factorOf({ ...CLEAN_SECURITY, honeypot: 'yes' })).toBe(1);
  });

  it('never produces NaN or out-of-range scores, even from hostile numbers', () => {
    let state = 42;
    const rand = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state / 2 ** 31;
    };
    const weird = [Number.NaN, Infinity, -Infinity, -100, 0, 1e12, -1e12, null];
    const pick = (): number | null =>
      rand() < 0.3 ? (weird[Math.floor(rand() * weird.length)] ?? null) : (rand() - 0.5) * 10 ** Math.floor(rand() * 6);
    for (let i = 0; i < 300; i++) {
      const s = snap({
        priceChangePct: { m5: pick(), h1: pick(), h6: pick(), h24: pick() },
        volumeUsd: { h1: pick() },
        liquidityUsd: pick(),
        marketCapUsd: pick(),
        fdvUsd: pick(),
        top10HolderPct: pick(),
        boosted: rand() < 0.2,
        security: rand() < 0.5 ? null : { mintAuthority: rand() < 0.5, freezeAuthority: null, honeypot: 'unknown', devHoldingPct: pick() },
      });
      const m = metrics({
        ageMinutes: pick(),
        txPerMin: pick(),
        txAcceleration: pick(),
        volumeAcceleration: pick(),
        buyPct: pick(),
        sellPct: pick(),
        uniqueBuyersM5: pick(),
        buyerAcceleration: pick(),
        holdersGrowthPct: pick(),
        liquidityChangePct: pick(),
        momentumScore: pick(),
        volatilityProxy: pick(),
        volumeToLiquidity: pick(),
        illiquidity: pick(),
      });
      const regime: MarketRegime = { label: 'neutral', breadthPct: pick(), medianH1ChangePct: pick(), sampleSize: 20, computedAt: T0 };
      expectWellFormed(matchQuant(s, m, regime, { socialMentions: pick() }));
    }
  });

  it('scores real provider snapshots without errors', () => {
    const snapshots = [
      ...parseGtPools(fixture('gt_new_pools_solana.json'), 'solana', T0),
      ...parseGtPools(fixture('gt_new_pools_base.json'), 'base', T0),
      ...parseDsPairs(fixture('ds_tokens_solana.json'), 'solana', T0),
    ];
    expect(snapshots.length).toBeGreaterThan(10);
    const regime = computeRegime(snapshots, T0);
    let withMatches = 0;
    for (const s of snapshots) {
      const r = matchQuant(s, deriveMetrics(s, [], T0), regime);
      expectWellFormed(r);
      if (r.matches.length) withMatches++;
    }
    expect(withMatches).toBeGreaterThan(0);
  });
});

/* ───────────────────────────── regime ───────────────────────────── */

describe('computeRegime', () => {
  const universe = (changes: number[], over: Partial<TokenSnapshot> = {}) =>
    changes.map((h1) => snap({ priceChangePct: { h1 }, liquidityUsd: 20_000, ...over }));

  it('labels a broad advance risk-on', () => {
    const r = computeRegime(universe([5, 8, 12, 3, 1, 20, 7, 2, -4, -1, 6, 9]), T0);
    expect(r).toEqual({ label: 'risk-on', breadthPct: (10 / 12) * 100, medianH1ChangePct: 5.5, sampleSize: 12, computedAt: T0 });
  });

  it('labels a broad decline risk-off', () => {
    const r = computeRegime(universe([-5, -8, -12, -3, -1, -20, -7, -2, 4, 1, 6, -9, -2]), T0);
    expect(r.label).toBe('risk-off');
    expect(r.breadthPct).toBeCloseTo((3 / 13) * 100, 6);
    expect(r.medianH1ChangePct).toBe(-3);
  });

  it('labels a mixed market neutral', () => {
    const r = computeRegime(universe([5, -5, 3, -3, 2, -2, 1, -1, 4, -4, 6, -6]), T0);
    expect(r.label).toBe('neutral');
    expect(r.breadthPct).toBe(50);
    expect(r.medianH1ChangePct).toBe(0);
  });

  it('reports unknown below the minimum sample and ignores thin, unpriced, stale or duplicate tokens', () => {
    const eligible = universe(Array.from({ length: MIN_REGIME_SAMPLE - 1 }, () => 10));
    const noise = [
      ...universe([50, 60], { liquidityUsd: 4_999 }),
      ...universe([50], { liquidityUsd: null }),
      snap({ priceChangePct: { h1: null }, liquidityUsd: 50_000 }),
      ...universe([70], { ts: T0 - 61 * MIN }),
      ...universe([300], { createdAt: T0 - 10 * MIN }),
      { ...eligible[0]!, ts: T0 - MIN },
    ];
    const r = computeRegime([...eligible, ...noise], T0);
    expect(r).toEqual({ label: 'unknown', breadthPct: null, medianH1ChangePct: null, sampleSize: MIN_REGIME_SAMPLE - 1, computedAt: T0 });
    expect(computeRegime([], T0).label).toBe('unknown');
    expect(computeRegime([...eligible, ...universe([1], { createdAt: T0 - 50 * MIN })], T0).label).toBe('risk-on');
  });

  it('computes a regime from real provider snapshots', () => {
    const snapshots = [
      ...parseGtPools(fixture('gt_new_pools_solana.json'), 'solana', T0),
      ...parseDsPairs(fixture('ds_tokens_solana.json'), 'solana', T0),
    ];
    const r = computeRegime(snapshots, T0);
    expect(r.sampleSize).toBeLessThanOrEqual(snapshots.length);
    if (r.sampleSize >= MIN_REGIME_SAMPLE) {
      expect(r.breadthPct).toBeGreaterThanOrEqual(0);
      expect(r.breadthPct).toBeLessThanOrEqual(100);
      expect(Number.isFinite(r.medianH1ChangePct)).toBe(true);
    } else {
      expect(r.label).toBe('unknown');
    }
  });
});

/* ───────────────────────────── leaders ───────────────────────────── */

describe('computeLeaders', () => {
  it('lists every methodology with its top tokens by score, best first', () => {
    const strong = { snapshot: momentumToken(), metrics: momentumMetrics(), articleId: 'a-strong' };
    const weaker = {
      snapshot: snap({ symbol: 'MILD', priceChangePct: { m5: 1, h1: 12, h6: 20 }, liquidityUsd: 40_000 }),
      metrics: metrics({ momentumScore: 40 }),
      articleId: null,
    };
    const tooWeak = {
      snapshot: snap({ symbol: 'FLAT', priceChangePct: { m5: 0, h1: 2, h6: 1 } }),
      metrics: metrics({ momentumScore: 3 }),
      articleId: null,
    };
    const dump = { snapshot: dumpToken(), metrics: dumpMetrics(), articleId: 'a-dump' };

    const leaders = computeLeaders([tooWeak, dump, weaker, strong], NEUTRAL_REGIME);
    expect(leaders.map((l) => l.methodologyId)).toEqual(METHODOLOGIES.map((m) => m.id));

    const momentum = leaders.find((l) => l.methodologyId === 'ts-momentum')!;
    expect(momentum.tokens.map((t) => t.symbol)).toEqual(['RALLY', 'MILD']);
    expect(momentum.tokens[0]).toMatchObject({ score: 100, articleId: 'a-strong', liquidityUsd: 85_000, marketCapUsd: 900_000 });

    const risk = leaders.find((l) => l.methodologyId === 'risk-overlay')!;
    expect(risk.tokens.map((t) => t.symbol)).toEqual(['DUMP']);

    for (const l of leaders) {
      for (const t of l.tokens) expect(t.score).toBeGreaterThanOrEqual(MIN_LEADER_SCORE);
    }
  });

  it('respects topN, breaks score ties by liquidity and keeps only the newest observation per token', () => {
    const entries = [10_000, 50_000, 30_000, 20_000].map((liquidityUsd, i) => ({
      snapshot: { ...momentumToken(), symbol: `R${i}`, liquidityUsd },
      metrics: momentumMetrics(),
      articleId: null,
    }));
    const stale = { ...entries[1]!, snapshot: { ...entries[1]!.snapshot, ts: T0 - 5 * MIN, liquidityUsd: 1e9 } };
    const leaders = computeLeaders([stale, ...entries], NEUTRAL_REGIME, 2);
    const momentum = leaders.find((l) => l.methodologyId === 'ts-momentum')!;
    expect(momentum.tokens.map((t) => [t.symbol, t.liquidityUsd])).toEqual([
      ['R1', 50_000],
      ['R2', 30_000],
    ]);
    expect(computeLeaders([], NEUTRAL_REGIME).every((l) => l.tokens.length === 0)).toBe(true);
  });
});
