import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DerivedMetrics, SignalCode, TokenSnapshot } from '../../shared/types.js';
import { detectAnomalies, severityFor, SIGNAL_MAX_WEIGHTS, type DetectOpts } from '../src/engine/anomaly.js';
import { deriveMetrics } from '../src/engine/metrics.js';
import { parseGtPools } from '../src/sources/geckoterminal.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 1, 21, 10);

const OPTS: DetectOpts = {
  thresholds: { WATCH: 45, ALERT: 62, BREAKING: 78 },
  minLiquidityUsd: 5000,
  minVolumeH1Usd: 5000,
};

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** A token that passes every gate. */
function snap(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    chain: 'solana',
    address: '6nyVgjjPGY9c7QpjMUPY8vS6sLzVoiq9VyxYoTvmpump',
    symbol: 'TEST',
    name: 'Test',
    pairAddress: null,
    dex: null,
    ts: T0,
    priceUsd: 0.001,
    marketCapUsd: null,
    fdvUsd: 500_000,
    liquidityUsd: 40_000,
    volumeUsd: { h1: 60_000 },
    priceChangePct: { h1: 34 },
    txns: {},
    holders: null,
    top10HolderPct: null,
    createdAt: T0 - 3 * 60 * MIN,
    imageUrl: null,
    links: [],
    security: null,
    sources: [],
    boosted: false,
    ...over,
  };
}

function metrics(over: Partial<DerivedMetrics> = {}): DerivedMetrics {
  return {
    ageMinutes: 180,
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
    ...over,
  };
}

/** Every signal at (or beyond) full strength. */
const HOT: DerivedMetrics = metrics({
  ageMinutes: 20,
  txPerMin: 30,
  volumeAcceleration: 9,
  txAcceleration: 8,
  buyerAcceleration: 7,
  uniqueBuyersM5: 150,
  holdersGrowthPct: 80,
  holdersGrowthWindowMin: 42,
  liquidityChangePct: 90,
  momentumScore: 95,
  buyPct: 88,
  sellPct: 12,
  buySellWindow: 'm5',
  avgTradeUsd: 2400,
  largeWalletFlow: 'high',
});

const codes = (d: { signals: Array<{ code: SignalCode }> }) => d.signals.map((x) => x.code).sort();

describe('gates', () => {
  it('rejects thin liquidity, thin volume, honeypots and old tokens, with readable reasons', () => {
    const d = detectAnomalies(
      snap({ liquidityUsd: 3120, volumeUsd: { h1: 812 }, security: { mintAuthority: false, freezeAuthority: false, honeypot: 'yes', devHoldingPct: null } }),
      { ...HOT, ageMinutes: 9 * 24 * 60 },
      OPTS,
    );
    expect(d.severity).toBeNull();
    expect(d.rejected).toEqual([
      'Liquidity $3,120 below $5,000 minimum',
      '1h volume $812 below $5,000 minimum',
      'Flagged as honeypot',
      'Older than 7 days (9.0d)',
    ]);
    // the score is still reported so the rejection is explainable
    expect(d.score).toBe(100);
  });

  it('treats unknown liquidity or volume as disqualifying', () => {
    const d = detectAnomalies(snap({ liquidityUsd: null, volumeUsd: {} }), HOT, OPTS);
    expect(d.severity).toBeNull();
    expect(d.rejected).toEqual(['Liquidity unknown', '1h volume unknown']);
  });

  it('does not reject on unknown age or unknown honeypot status', () => {
    const d = detectAnomalies(
      snap({ security: { mintAuthority: null, freezeAuthority: null, honeypot: 'unknown', devHoldingPct: null } }),
      { ...HOT, ageMinutes: null },
      OPTS,
    );
    expect(d.rejected).toEqual([]);
    expect(d.severity).toBe('BREAKING');
  });

  it('rejects low-liquidity pools from the real GeckoTerminal feed', () => {
    const pools = parseGtPools(fixture('gt_new_pools_solana.json'), 'solana', T0);
    const fired = pools.find((p) => p.symbol === 'FIRED');
    expect(fired).toBeDefined();
    if (!fired) return;
    const d = detectAnomalies(fired, deriveMetrics(fired, [], T0), OPTS);
    expect(d.severity).toBeNull();
    expect(d.rejected).toContain('Liquidity $4,058 below $5,000 minimum');
    expect(d.rejected).toContain('1h volume $15 below $5,000 minimum');
  });
});

describe('scoring', () => {
  it('caps the score at 100 and fires every signal at full weight', () => {
    const d = detectAnomalies(snap(), HOT, { ...OPTS, socialMentions: 40 });
    expect(d.score).toBe(100);
    expect(d.severity).toBe('BREAKING');
    expect(codes(d)).toEqual(Object.keys(SIGNAL_MAX_WEIGHTS).sort());
    for (const s of d.signals) expect(s.weight).toBe(SIGNAL_MAX_WEIGHTS[s.code]);
  });

  it('a quiet token scores zero with no signals', () => {
    const d = detectAnomalies(
      snap(),
      metrics({ volumeAcceleration: 1.1, txAcceleration: 0.9, buyPct: 51, buySellWindow: 'h1', momentumScore: 5 }),
      OPTS,
    );
    expect(d).toEqual({ score: 0, severity: null, signals: [], rejected: [] });
  });

  it('ramps smoothly: halfway between onset and saturation earns half the weight', () => {
    const d = detectAnomalies(snap(), metrics({ volumeAcceleration: 4 }), OPTS);
    expect(d.signals).toEqual([{ code: 'volume_surge', label: 'Volume 4.0x vs 1h avg', value: 4, weight: 11 }]);
    expect(d.score).toBe(11);
  });

  it('is monotonic in every input', () => {
    const sweeps: Array<[keyof DerivedMetrics, number[]]> = [
      ['volumeAcceleration', [0, 1, 2, 2.5, 3, 4, 5, 6, 8, 20]],
      ['txAcceleration', [0, 1, 2, 2.5, 3, 4, 5, 6, 8, 20]],
      ['buyerAcceleration', [0, 1, 2, 3, 4, 5, 6, 10]],
      ['uniqueBuyersM5', [0, 20, 40, 60, 80, 120, 400]],
      ['holdersGrowthPct', [-20, 0, 10, 20, 35, 50, 200]],
      ['liquidityChangePct', [-50, 0, 15, 30, 60, 100]],
      ['momentumScore', [-100, 0, 35, 50, 65, 80, 100]],
      ['txPerMin', [0, 4, 5, 7, 10, 40]],
    ];
    for (const [key, xs] of sweeps) {
      const scores = xs.map((x) => {
        const m = metrics({ ageMinutes: 20, buyPct: 55, buySellWindow: 'h1', [key]: x });
        return detectAnomalies(snap(), m, OPTS).score;
      });
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i], `${key}=${xs[i]}`).toBeGreaterThanOrEqual(scores[i - 1] ?? 0);
      }
      expect(scores.at(-1), key).toBeGreaterThan(scores[0] ?? 0);
    }

    const social = [0, 3, 5, 9, 15, 50].map((n) => detectAnomalies(snap(), metrics(), { ...OPTS, socialMentions: n }).score);
    expect(social).toEqual([...social].sort((a, b) => a - b));
    expect(social.at(-1)).toBe(SIGNAL_MAX_WEIGHTS.social_attention);
  });

  it('labels signals compactly with the real numbers, strongest first', () => {
    const d = detectAnomalies(
      snap({ priceChangePct: { h1: 34.4 } }),
      metrics({
        ageMinutes: 25,
        txPerMin: 12.3,
        volumeAcceleration: 4.2,
        txAcceleration: 3.1,
        buyerAcceleration: 2.6,
        uniqueBuyersM5: 44,
        holdersGrowthPct: 31.2,
        holdersGrowthWindowMin: 42,
        liquidityChangePct: 22,
        momentumScore: 58.4,
        buyPct: 71.2,
        sellPct: 28.8,
        buySellWindow: 'h1',
        avgTradeUsd: 2431.4,
        largeWalletFlow: 'high',
      }),
      { ...OPTS, socialMentions: 9 },
    );
    const labels = Object.fromEntries(d.signals.map((s) => [s.code, s.label]));
    expect(labels).toEqual({
      volume_surge: 'Volume 4.2x vs 1h avg',
      tx_acceleration: 'Trades 3.1x vs 1h avg',
      buyer_surge: 'Unique buyers 2.6x vs 1h avg',
      holder_growth: '+31% holders / 42m',
      liquidity_growth: 'Liquidity +22% within 1h',
      momentum: 'Momentum 58/100 (1h +34%)',
      buy_pressure: '71% buys (1h)',
      large_wallet_flow: 'Avg trade $2,431 (large)',
      social_attention: '9 mentions in 2h',
      fresh_launch: 'Launched 25m ago · 12 tx/min',
    });
    const weights = d.signals.map((s) => s.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    expect(d.signals.find((s) => s.code === 'holder_growth')?.value).toBe(31.2);
  });

  it('buyer surge takes whichever of acceleration or crowd size is stronger', () => {
    const byCrowd = detectAnomalies(snap(), metrics({ buyerAcceleration: 2.2, uniqueBuyersM5: 100 }), OPTS);
    expect(byCrowd.signals[0]?.label).toBe('100 unique buyers in 5m');
    const byAccel = detectAnomalies(snap(), metrics({ buyerAcceleration: 5, uniqueBuyersM5: 41 }), OPTS);
    expect(byAccel.signals[0]?.label).toBe('Unique buyers 5.0x vs 1h avg');
  });

  it('fresh launch fades out between 30 and 60 minutes of age', () => {
    const weightAt = (age: number) =>
      detectAnomalies(snap(), metrics({ ageMinutes: age, txPerMin: 20 }), OPTS).signals.find(
        (s) => s.code === 'fresh_launch',
      )?.weight ?? 0;
    expect(weightAt(10)).toBe(6);
    expect(weightAt(45)).toBe(3);
    expect(weightAt(60)).toBe(0);
    expect(weightAt(61)).toBe(0);
  });

  it('is deterministic', () => {
    const a = detectAnomalies(snap(), HOT, { ...OPTS, socialMentions: 7 });
    const b = detectAnomalies(snap(), HOT, { ...OPTS, socialMentions: 7 });
    expect(a).toEqual(b);
  });
});

describe('severity', () => {
  it('maps score to severity with the configured thresholds', () => {
    const t = OPTS.thresholds;
    expect(severityFor(44, t)).toBeNull();
    expect(severityFor(45, t)).toBe('WATCH');
    expect(severityFor(61, t)).toBe('WATCH');
    expect(severityFor(62, t)).toBe('ALERT');
    expect(severityFor(77, t)).toBe('ALERT');
    expect(severityFor(78, t)).toBe('BREAKING');
    expect(severityFor(100, t)).toBe('BREAKING');
  });

  it('respects custom thresholds', () => {
    const m = metrics({ volumeAcceleration: 6, txAcceleration: 6 }); // 22 + 16 = 38
    expect(detectAnomalies(snap(), m, OPTS).severity).toBeNull();
    expect(detectAnomalies(snap(), m, { ...OPTS, thresholds: { WATCH: 30, ALERT: 38, BREAKING: 90 } }).severity).toBe(
      'ALERT',
    );
  });
});
