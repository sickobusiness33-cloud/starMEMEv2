/*
 * Chain-relative launch traction. Launch activity differs by chain: live, an EVM
 * launch that clears the market gates trades ~$5-7K a minute where a Solana launch
 * trades ~$10K, so one global ramp ($10K onset) left the feed Solana-only. Each chain
 * keeps a rolling baseline of how much young tokens trade per minute, and the
 * fresh_launch ramp is scaled to it: onset at the chain's median, full weight a
 * little above its top decile (the global calibration's shape: $10K median, $40K
 * p90 → $10K onset, $50K full). Too few launches → the global defaults.
 * The absolute market gates (MIN_LIQUIDITY_USD / MIN_VOLUME_H1_USD) still apply.
 */
import type { ChainId, TokenSnapshot } from '../../../shared/types.js';
import { tokenKey } from '../db/db.js';
import { DEFAULT_LAUNCH_RAMP, launchVolumePerMinute, type LaunchRamp } from './anomaly.js';
import { windowAgeMinutes } from './metrics.js';

const MINUTE_MS = 60_000;

/** a launch is observed while it is at most this old (its launch hour plus the fade-out) */
export const BASELINE_MAX_AGE_MIN = 90;
/** observations older than this leave the baseline */
export const BASELINE_WINDOW_MS = 6 * 60 * MINUTE_MS;
/** fewer launches than this on a chain: the global defaults */
export const BASELINE_MIN_SAMPLE = 30;
/** the ramp is recomputed at most this often */
export const BASELINE_TTL_MS = 5 * MINUTE_MS;
/** the scanner's young tokens are never "fresh" before this (snipers and bots own the first minutes) */
const MIN_OBSERVED_AGE_MIN = 2;
/** reference percentiles of the global calibration */
const REFERENCE_P50 = 10_000;
const REFERENCE_P90 = 40_000;
/**
 * A chain baseline can move the ramp at most this far from the global calibration,
 * so a dead hour (or one bot farm) cannot make every launch "fresh" or none.
 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const MAX_TRACKED_TOKENS = 20_000;

export interface MarketGates {
  minLiquidityUsd: number;
  minVolumeH1Usd: number;
}

export interface ChainBaseline {
  chain: ChainId;
  /** launches in the sample */
  sample: number;
  p50PerMin: number | null;
  p90PerMin: number | null;
  ramp: LaunchRamp;
  /** 'chain' when the ramp comes from this chain's launches, 'default' when the sample was too small */
  source: 'chain' | 'default';
}

/**
 * Volume per minute of a young token's launch, or null when the snapshot does not
 * describe a launch clearing the market gates (age known, 2-90 min, liquidity and
 * 1 h volume at or above the minimums). Measured at the snapshot's own time.
 */
export function launchRate(s: TokenSnapshot, gates: MarketGates): number | null {
  if (s.createdAt == null) return null;
  const age = (s.ts - s.createdAt) / MINUTE_MS;
  if (!(age >= MIN_OBSERVED_AGE_MIN && age <= BASELINE_MAX_AGE_MIN)) return null;
  const volume = s.volumeUsd.h1 ?? null;
  if (volume == null || volume < gates.minVolumeH1Usd) return null;
  if (s.liquidityUsd == null || s.liquidityUsd < gates.minLiquidityUsd) return null;
  return launchVolumePerMinute(volume, age, windowAgeMinutes(s, age, s.ts));
}

/** p-th percentile (0-100) by linear interpolation; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}

/** The launch ramp for a chain whose launches trade `rates` per minute (one value per token). */
export function baselineFor(chain: ChainId, rates: number[]): ChainBaseline {
  const p50 = percentile(rates, 50);
  const p90 = percentile(rates, 90);
  if (rates.length < BASELINE_MIN_SAMPLE || p50 == null || p90 == null || p50 <= 0) {
    return { chain, sample: rates.length, p50PerMin: p50, p90PerMin: p90, ramp: { ...DEFAULT_LAUNCH_RAMP }, source: 'default' };
  }
  const onsetScale = clamp(p50 / REFERENCE_P50, MIN_SCALE, MAX_SCALE);
  const fullScale = clamp(p90 / REFERENCE_P90, MIN_SCALE, MAX_SCALE);
  const onsetPerMin = DEFAULT_LAUNCH_RAMP.onsetPerMin * onsetScale;
  // full weight always sits well above the onset, whatever the spread of the sample
  const fullPerMin = Math.max(DEFAULT_LAUNCH_RAMP.fullPerMin * fullScale, onsetPerMin * 2);
  return {
    chain,
    sample: rates.length,
    p50PerMin: p50,
    p90PerMin: p90,
    ramp: { onsetPerMin: round(onsetPerMin), fullPerMin: round(fullPerMin) },
    source: 'chain',
  };
}

/**
 * Rolling per-chain launch baselines over the last 6 hours. Every snapshot the
 * scanner processes is offered with `observe` (one entry per token: its latest
 * launch-phase reading, so a token that has since aged still counts). On the first
 * computation `load` (e.g. `db.latestSnapshots`) seeds what storage already holds,
 * so a restart does not start from an empty sample. Ramps are recomputed at most
 * every 5 minutes.
 */
export class LaunchBaselines {
  private readonly launches = new Map<string, { chain: ChainId; perMin: number; at: number }>();
  private computed: { at: number; byChain: Map<ChainId, ChainBaseline> } | null = null;
  private seeded = false;

  constructor(
    private readonly gates: MarketGates,
    private readonly load?: (sinceTs: number) => TokenSnapshot[],
  ) {}

  /** Records a token's launch-phase reading (ignored when the snapshot is not one). */
  observe(s: TokenSnapshot): void {
    const perMin = launchRate(s, this.gates);
    if (perMin == null) return;
    const key = tokenKey(s.chain, s.address);
    this.launches.delete(key);
    this.launches.set(key, { chain: s.chain, perMin, at: s.ts });
    if (this.launches.size > MAX_TRACKED_TOKENS) {
      const oldest = this.launches.keys().next().value;
      if (oldest !== undefined) this.launches.delete(oldest);
    }
  }

  /** Bulk `observe` (e.g. the latest stored observation of every token seen in the last 6 h). */
  seed(snapshots: TokenSnapshot[]): void {
    for (const s of [...snapshots].sort((a, b) => a.ts - b.ts)) this.observe(s);
    this.computed = null;
  }

  /** The ramp for a chain, recomputed at most every 5 minutes. */
  rampFor(chain: ChainId, now: number): LaunchRamp {
    return this.baseline(chain, now).ramp;
  }

  baseline(chain: ChainId, now: number): ChainBaseline {
    if (!this.computed || now - this.computed.at >= BASELINE_TTL_MS) this.recompute(now);
    return this.computed?.byChain.get(chain) ?? baselineFor(chain, []);
  }

  private recompute(now: number): void {
    if (!this.seeded && this.load) {
      this.seeded = true;
      try {
        this.seed(this.load(now - BASELINE_WINDOW_MS));
      } catch {
        // storage unavailable: the in-memory observations (or the defaults) still apply
      }
    }
    const rates = new Map<ChainId, number[]>();
    for (const [key, entry] of this.launches) {
      if (now - entry.at > BASELINE_WINDOW_MS) {
        this.launches.delete(key);
        continue;
      }
      const list = rates.get(entry.chain) ?? [];
      list.push(entry.perMin);
      rates.set(entry.chain, list);
    }
    const byChain = new Map<ChainId, ChainBaseline>();
    for (const [chain, list] of rates) byChain.set(chain, baselineFor(chain, list));
    this.computed = { at: now, byChain };
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function round(x: number): number {
  return Math.round(x);
}
