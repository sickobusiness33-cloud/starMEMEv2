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
  breakingMinLiquidityUsd: 25_000,
  breakingMinVolumeH1Usd: 75_000,
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

/**
 * Every signal at (or beyond) full strength. At exactly 60 minutes momentum is fully
 * phased in and launch traction has not started fading yet.
 */
const HOT: DerivedMetrics = metrics({
  ageMinutes: 60,
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

/** A launch-hour market strong enough for full launch traction: $3M in 60 minutes over 1,200 trades. */
const HOT_SNAP: Partial<TokenSnapshot> = {
  volumeUsd: { m5: 400_000, h1: 3_000_000 },
  txns: { h1: { buys: 700, sells: 500, buyers: null, sellers: null } },
};

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
      snap({ ...HOT_SNAP, security: { mintAuthority: null, freezeAuthority: null, honeypot: 'unknown', devHoldingPct: null } }),
      { ...HOT, ageMinutes: null },
      OPTS,
    );
    expect(d.rejected).toEqual([]);
    expect(d.severity).toBe('BREAKING');
    expect(d).not.toHaveProperty('caps'); // unknown mint/freeze/holder data never caps
  });

  it('never publishes a pool whose liquidity was pulled (-50% or worse within the hour)', () => {
    const pulled = detectAnomalies(snap(HOT_SNAP), { ...HOT, liquidityChangePct: -62 }, OPTS);
    expect(pulled.severity).toBeNull();
    expect(pulled.rejected).toEqual(['Liquidity pulled (-62% within 1h)']);
    expect(detectAnomalies(snap(HOT_SNAP), { ...HOT, liquidityChangePct: -49 }, OPTS).severity).toBe('BREAKING');
    expect(detectAnomalies(snap(HOT_SNAP), { ...HOT, liquidityChangePct: -50 }, OPTS).rejected).toEqual([
      'Liquidity pulled (-50% within 1h)',
    ]);
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
    const d = detectAnomalies(snap(HOT_SNAP), HOT, { ...OPTS, socialMentions: 40 });
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
    expect(d.signals).toEqual([{ code: 'volume_surge', label: 'Volume 4.0x vs 1h avg', value: 4, weight: 15 }]);
    expect(d.score).toBe(15);
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
    ];
    for (const [key, xs] of sweeps) {
      const scores = xs.map((x) => {
        const m = metrics({ ageMinutes: 120, buyPct: 55, buySellWindow: 'h1', [key]: x });
        return detectAnomalies(snap(), m, OPTS).score;
      });
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i], `${key}=${xs[i]}`).toBeGreaterThanOrEqual(scores[i - 1] ?? 0);
      }
      expect(scores.at(-1), key).toBeGreaterThan(scores[0] ?? 0);
    }

    const launchVolume = [10_000, 300_000, 600_000, 1_200_000, 3_000_000, 9_000_000].map(
      (h1) =>
        detectAnomalies(snap({ volumeUsd: { h1 }, txns: HOT_SNAP.txns }), metrics({ ageMinutes: 30 }), OPTS).score,
    );
    expect(launchVolume).toEqual([...launchVolume].sort((a, b) => a - b));
    expect(launchVolume.at(-1)).toBe(SIGNAL_MAX_WEIGHTS.fresh_launch);

    const social = [0, 3, 5, 9, 15, 50].map((n) => detectAnomalies(snap(), metrics(), { ...OPTS, socialMentions: n }).score);
    expect(social).toEqual([...social].sort((a, b) => a - b));
    expect(social.at(-1)).toBe(SIGNAL_MAX_WEIGHTS.social_attention);
  });

  it('labels signals compactly with the real numbers, strongest first', () => {
    const d = detectAnomalies(
      snap({
        priceChangePct: { h1: 34.4 },
        volumeUsd: { h1: 600_000 },
        txns: { h1: { buys: 700, sells: 540, buyers: null, sellers: null } },
      }),
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
      momentum: 'Momentum 58/100', // 25 minutes old: the "1h" change is the move since launch
      buy_pressure: '71% buys (1h)',
      large_wallet_flow: 'Avg trade $2,431 (large)',
      social_attention: '9 mentions in 2h (name or contract)',
      fresh_launch: 'Launched 25m ago · $600K volume, 1,240 trades',
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

  it('launch traction needs real volume, enough trades and a few minutes of survival, and fades by 90 minutes', () => {
    const weight = (age: number, h1Volume: number, trades = 1_200) =>
      detectAnomalies(
        snap({ volumeUsd: { h1: h1Volume }, txns: { h1: { buys: trades / 2, sells: trades / 2, buyers: null, sellers: null } } }),
        metrics({ ageMinutes: age }),
        OPTS,
      ).signals.find((s) => s.code === 'fresh_launch')?.weight ?? 0;
    const full = SIGNAL_MAX_WEIGHTS.fresh_launch;
    // $50K+ a minute is full traction; the typical launch (~$10K a minute) earns nothing
    expect(weight(20, 20 * 50_000)).toBe(full);
    expect(weight(20, 20 * 10_000)).toBe(0);
    expect(weight(20, 20 * 30_000)).toBe(full / 2);
    // one wallet cannot fake it: under 30 trades there is no traction, full credit from 150
    expect(weight(20, 20 * 50_000, 30)).toBe(0);
    expect(weight(20, 20 * 50_000, 90)).toBe(full / 2);
    // the first two minutes belong to snipers; full credit from 10 minutes
    expect(weight(2, 2 * 50_000)).toBe(0);
    expect(weight(6, 6 * 50_000)).toBe(full / 2);
    // fades between 60 and 90 minutes, when the 1 h baseline no longer holds the launch
    expect(weight(60, 60 * 50_000)).toBe(full);
    expect(weight(75, 60 * 50_000)).toBe(full / 2);
    expect(weight(90, 60 * 50_000)).toBe(0);
    expect(weight(120, 60 * 50_000)).toBe(0);
  });

  it('phases momentum in over the launch hour', () => {
    const weight = (age: number) =>
      detectAnomalies(snap(), metrics({ ageMinutes: age, momentumScore: 95 }), OPTS).signals.find(
        (s) => s.code === 'momentum',
      )?.weight ?? 0;
    expect(weight(10)).toBe(0);
    expect(weight(35)).toBe(SIGNAL_MAX_WEIGHTS.momentum / 2);
    expect(weight(60)).toBe(SIGNAL_MAX_WEIGHTS.momentum);
    expect(weight(600)).toBe(SIGNAL_MAX_WEIGHTS.momentum);
  });

  it('is deterministic', () => {
    const a = detectAnomalies(snap(), HOT, { ...OPTS, socialMentions: 7 });
    const b = detectAnomalies(snap(), HOT, { ...OPTS, socialMentions: 7 });
    expect(a).toEqual(b);
  });
});

describe('BREAKING policy', () => {
  const breaking = (over: Partial<TokenSnapshot>) => detectAnomalies(snap({ ...HOT_SNAP, liquidityUsd: 400_000, ...over }), HOT, OPTS);

  it('needs real size: liquidity of $25K and 1h volume of $75K, otherwise the story is held at ALERT', () => {
    // live regression: $12K of 1 h volume and a $31K market cap went out as BREAKING
    const tiny = breaking({ liquidityUsd: 18_000, volumeUsd: { m5: 4_000, h1: 12_000 }, marketCapUsd: 31_000 });
    expect(tiny.score).toBe(100);
    expect(tiny.severity).toBe('ALERT');
    expect(tiny.caps).toEqual([
      'Liquidity $18,000 below the $25,000 BREAKING minimum',
      '1h volume $12,000 below the $75,000 BREAKING minimum',
    ]);
    expect(breaking({ liquidityUsd: 25_000, volumeUsd: { h1: 75_000 } }).severity).toBe('BREAKING');
    expect(breaking({ volumeUsd: { h1: 74_999 } }).severity).toBe('ALERT');
  });

  it('holds concentrated or mintable tokens at ALERT', () => {
    const concentrated = breaking({ top10HolderPct: 92 });
    expect(concentrated.severity).toBe('ALERT');
    expect(concentrated.caps).toEqual(['Top 10 holders own 92% of supply']);
    expect(breaking({ top10HolderPct: 79.9 }).severity).toBe('BREAKING');
    const authority = breaking({ security: { mintAuthority: true, freezeAuthority: true, honeypot: 'no', devHoldingPct: null } });
    expect(authority.severity).toBe('ALERT');
    expect(authority.caps).toEqual(['Mint authority enabled', 'Freeze authority enabled']);
  });

  it('only caps BREAKING: ALERT and WATCH scores are untouched and carry no caps', () => {
    const m = metrics({ volumeAcceleration: 6, txAcceleration: 6, buyerAcceleration: 6 }); // 30 + 20 + 22 = 72 → ALERT
    const d = detectAnomalies(snap({ top10HolderPct: 95, liquidityUsd: 6_000 }), m, OPTS);
    expect(d.severity).toBe('ALERT');
    expect(d).not.toHaveProperty('caps');
  });
});

describe('launch ramp', () => {
  const launch = (perMinute: number, launchRamp?: DetectOpts['launchRamp']) =>
    detectAnomalies(
      snap({ volumeUsd: { h1: 20 * perMinute }, txns: { h1: { buys: 600, sells: 600, buyers: null, sellers: null } } }),
      metrics({ ageMinutes: 20 }),
      { ...OPTS, ...(launchRamp ? { launchRamp } : {}) },
    ).signals.find((s) => s.code === 'fresh_launch')?.weight ?? 0;

  it('scales with the chain baseline it is given', () => {
    const full = SIGNAL_MAX_WEIGHTS.fresh_launch;
    // an EVM launch at $6K a minute is nothing on the global ramp ($10K onset)...
    expect(launch(6_000)).toBe(0);
    // ...but on a chain whose launches trade $4K / $20K (p50 / p90-based ramp) it is a standout
    expect(launch(6_000, { onsetPerMin: 4_000, fullPerMin: 8_000 })).toBe(full / 2);
    expect(launch(8_000, { onsetPerMin: 4_000, fullPerMin: 8_000 })).toBe(full);
  });

  it("divides by the measured pool's age, not the token's", () => {
    const at = (windowAgeMinutes: number | null) =>
      detectAnomalies(
        snap({ volumeUsd: { h1: 600_000 }, txns: { h1: { buys: 600, sells: 600, buyers: null, sellers: null } } }),
        metrics({ ageMinutes: 40, windowAgeMinutes }),
        OPTS,
      ).signals.find((s) => s.code === 'fresh_launch')?.value;
    expect(at(null)).toBeCloseTo(600_000 / 40, 6);
    expect(at(5)).toBeCloseTo(600_000 / 5, 6); // the pool traded all of it in its 5 minutes
  });

  it("leaves the 1h price change out of the momentum label while it only measures the launch", () => {
    const label = (m: Partial<DerivedMetrics>) =>
      detectAnomalies(snap({ priceChangePct: { h1: 450 } }), metrics({ momentumScore: 90, ...m }), OPTS).signals.find(
        (s) => s.code === 'momentum',
      )?.label;
    expect(label({ ageMinutes: 180 })).toBe('Momentum 90/100 (1h +450%)');
    expect(label({ ageMinutes: 40 })).toBe('Momentum 90/100');
    expect(label({ ageMinutes: 180, windowAgeMinutes: 30 })).toBe('Momentum 90/100');
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
    const m = metrics({ volumeAcceleration: 6, txAcceleration: 6 }); // 30 + 20 = 50
    expect(detectAnomalies(snap(), m, { ...OPTS, thresholds: { WATCH: 55, ALERT: 62, BREAKING: 78 } }).severity).toBeNull();
    expect(detectAnomalies(snap(), m, { ...OPTS, thresholds: { WATCH: 30, ALERT: 50, BREAKING: 90 } }).severity).toBe(
      'ALERT',
    );
  });
});
