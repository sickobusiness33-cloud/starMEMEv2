import { describe, expect, it, vi } from 'vitest';
import type { TokenSnapshot } from '../../shared/types.js';
import { DEFAULT_LAUNCH_RAMP } from '../src/engine/anomaly.js';
import {
  BASELINE_MIN_SAMPLE,
  BASELINE_TTL_MS,
  BASELINE_WINDOW_MS,
  baselineFor,
  launchRate,
  LaunchBaselines,
  percentile,
} from '../src/engine/baselines.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 12, 0);
const GATES = { minLiquidityUsd: 10_000, minVolumeH1Usd: 10_000 };

let n = 0;
function launch(chain: string, perMinute: number, over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  n += 1;
  const age = 30;
  return {
    chain,
    address: `0x${n.toString(16).padStart(40, '0')}`,
    symbol: `T${n}`,
    name: `Token ${n}`,
    pairAddress: null,
    dex: null,
    ts: T0,
    priceUsd: 0.01,
    marketCapUsd: 500_000,
    fdvUsd: null,
    liquidityUsd: 40_000,
    volumeUsd: { h1: perMinute * age },
    priceChangePct: {},
    txns: {},
    holders: null,
    top10HolderPct: null,
    createdAt: T0 - age * MIN,
    imageUrl: null,
    links: [],
    security: null,
    sources: ['dexscreener'],
    boosted: false,
    ...over,
  };
}

describe('launchRate', () => {
  it('is the 1h volume per minute of a young token that clears the market gates', () => {
    expect(launchRate(launch('base', 6_000), GATES)).toBeCloseTo(6_000, 6);
    // a pool younger than the token traded its volume in fewer minutes
    expect(launchRate(launch('base', 6_000, { pairCreatedAt: T0 - 10 * MIN }), GATES)).toBeCloseTo(18_000, 6);
  });

  it('ignores dust, unknown ages, sniper minutes and tokens past their launch phase', () => {
    expect(launchRate(launch('base', 6_000, { liquidityUsd: 9_000 }), GATES)).toBeNull();
    expect(launchRate(launch('base', 300), GATES)).toBeNull(); // $9K of 1 h volume
    expect(launchRate(launch('base', 6_000, { createdAt: null }), GATES)).toBeNull();
    expect(launchRate(launch('base', 6_000, { createdAt: T0 - MIN }), GATES)).toBeNull();
    expect(launchRate(launch('base', 6_000, { createdAt: T0 - 91 * MIN }), GATES)).toBeNull();
  });
});

describe('baselineFor', () => {
  it('interpolates percentiles', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([4, 1, 3, 2], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 90)).toBeCloseTo(10, 9);
  });

  it('keeps the global calibration when the chain has too few launches', () => {
    const b = baselineFor('ethereum', Array.from({ length: BASELINE_MIN_SAMPLE - 1 }, () => 5_000));
    expect(b.source).toBe('default');
    expect(b.ramp).toEqual(DEFAULT_LAUNCH_RAMP);
  });

  it('reproduces the global ramp from a sample shaped like the global calibration', () => {
    // p50 $10K, p90 $40K → $10K onset, $50K full
    const rates = Array.from({ length: 101 }, (_, i) =>
      i < 50 ? 5_000 : i === 50 ? 10_000 : i < 90 ? 20_000 : i === 90 ? 40_000 : 60_000,
    );
    const b = baselineFor('solana', rates);
    expect(b.source).toBe('chain');
    expect([b.p50PerMin, b.p90PerMin]).toEqual([10_000, 40_000]);
    expect(b.ramp).toEqual(DEFAULT_LAUNCH_RAMP);
  });

  it('scales the ramp to a slower chain, within bounds', () => {
    // live: EVM launches trade ~$5-7K a minute where Solana trades ~$10K
    const evm = baselineFor('base', Array.from({ length: 40 }, (_, i) => 3_000 + i * 200)); // p50 ≈ $6.9K, p90 ≈ $10K
    expect(evm.source).toBe('chain');
    expect(evm.ramp.onsetPerMin).toBeLessThan(DEFAULT_LAUNCH_RAMP.onsetPerMin);
    expect(evm.ramp.onsetPerMin).toBeCloseTo(evm.p50PerMin!, -1);
    expect(evm.ramp.fullPerMin).toBeGreaterThanOrEqual(evm.ramp.onsetPerMin * 2);
    // a dead hour cannot make every launch "fresh"
    const dead = baselineFor('bsc', Array.from({ length: 40 }, () => 200));
    expect(dead.ramp.onsetPerMin).toBe(DEFAULT_LAUNCH_RAMP.onsetPerMin * 0.25);
  });
});

describe('LaunchBaselines', () => {
  it('builds per-chain ramps from observed launches, recomputed at most every 5 minutes', () => {
    const b = new LaunchBaselines(GATES);
    for (let i = 0; i < 40; i++) b.observe(launch('base', 4_000 + i * 100));
    for (let i = 0; i < 40; i++) b.observe(launch('solana', 9_000 + i * 500));
    const base = b.baseline('base', T0);
    expect(base.source).toBe('chain');
    expect(base.sample).toBe(40);
    expect(b.rampFor('base', T0).onsetPerMin).toBeLessThan(b.rampFor('solana', T0).onsetPerMin);
    expect(b.baseline('ethereum', T0).source).toBe('default');

    // new launches only show up after the 5-minute recompute
    for (let i = 0; i < 40; i++) b.observe(launch('ethereum', 5_000));
    expect(b.baseline('ethereum', T0 + BASELINE_TTL_MS - 1).source).toBe('default');
    expect(b.baseline('ethereum', T0 + BASELINE_TTL_MS).source).toBe('chain');
  });

  it('counts each token once (its latest launch-phase reading) and forgets launches older than 6 h', () => {
    const b = new LaunchBaselines(GATES);
    const token = launch('base', 4_000);
    for (let i = 0; i < 40; i++) b.observe({ ...token, ts: T0 + i * 1_000 });
    expect(b.baseline('base', T0 + 60_000).sample).toBe(1);
    expect(b.baseline('base', T0 + BASELINE_WINDOW_MS + 10 * MIN).sample).toBe(0);
  });

  it('seeds itself from storage once, so a restart does not start from nothing', () => {
    const stored = Array.from({ length: 35 }, () => launch('bsc', 6_000));
    const load = vi.fn(() => stored);
    const b = new LaunchBaselines(GATES, load);
    expect(b.baseline('bsc', T0).source).toBe('chain');
    expect(load).toHaveBeenCalledWith(T0 - BASELINE_WINDOW_MS);
    b.baseline('bsc', T0 + BASELINE_TTL_MS);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
