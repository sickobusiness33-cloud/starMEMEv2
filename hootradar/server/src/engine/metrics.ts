import type { CardMetrics, DerivedMetrics, TimeWindow, TokenSnapshot, TxCounts } from '../../../shared/types.js';
import { addressKey } from '../sources/merge.js';

const MINUTE_MS = 60_000;

/** Minimum sample sizes below which a ratio is noise rather than information. */
const MIN_H1_TXNS_FOR_ACCEL = 10;
const MIN_H1_VOLUME_FOR_ACCEL_USD = 500;
const MIN_H1_BUYERS_FOR_ACCEL = 5;
const MIN_TXNS_FOR_BUY_SHARE = 10;
const MIN_H1_TXNS_FOR_WALLET_FLOW = 5;
const MIN_H1_VOLUME_FOR_ILLIQUIDITY_USD = 1000;

/** History-based growth compares against our own snapshots from this window. */
const GROWTH_LOOKBACK_MS = 60 * MINUTE_MS;
const GROWTH_MIN_SPAN_MS = 3 * MINUTE_MS;

const BUY_SHARE_WINDOWS: TimeWindow[] = ['m5', 'h1', 'h24'];

/**
 * Momentum blends price change across horizons. Each change is squashed with
 * tanh(pct / scale) so one parabolic window cannot dominate; scales grow with
 * the horizon because longer windows naturally move more. A window longer than
 * the token's life only measures the return since its (arbitrary) launch price —
 * a 20-minute-old token is "+300% in 1 h" by construction — so such windows are
 * left out and the remaining ones renormalized.
 */
const MOMENTUM_COMPONENTS: Array<{ window: TimeWindow; minutes: number; weight: number; scale: number }> = [
  { window: 'm5', minutes: 5, weight: 0.2, scale: 10 },
  { window: 'h1', minutes: 60, weight: 0.5, scale: 25 },
  { window: 'h6', minutes: 360, weight: 0.3, scale: 50 },
];

/** Volume measured over h1 is used instead of h24 while the token is younger than this. */
const YOUNG_TOKEN_MINUTES = 120;

export function deriveMetrics(s: TokenSnapshot, history: TokenSnapshot[], now: number): DerivedMetrics {
  const ageMinutes = s.createdAt != null ? Math.max(0, (now - s.createdAt) / MINUTE_MS) : null;
  const windowAge = windowAgeMinutes(s, ageMinutes, now);
  const m5Txns = txTotal(s.txns.m5);
  const h1Txns = txTotal(s.txns.h1);
  const h1Volume = s.volumeUsd.h1 ?? null;
  const buySell = buySellShare(s);
  const holders = growthFromHistory(s, history, (x) => x.holders);
  // a liquidity series is only comparable within one pool, one provider and one valuation method
  const liquidity = growthFromHistory(s, history, (x) => x.liquidityUsd, sameLiquiditySeries);
  const avgTradeUsd = h1Volume != null && h1Txns != null && h1Txns > 0 ? h1Volume / h1Txns : null;

  return {
    ageMinutes,
    windowAgeMinutes: windowAge,
    txPerMin: m5Txns != null ? m5Txns / coveredMinutes(5, windowAge ?? ageMinutes) : null,
    txAcceleration: acceleration(m5Txns, h1Txns, MIN_H1_TXNS_FOR_ACCEL, windowAge),
    volumeAcceleration: acceleration(s.volumeUsd.m5 ?? null, h1Volume, MIN_H1_VOLUME_FOR_ACCEL_USD, windowAge),
    buyPct: buySell?.buyPct ?? null,
    sellPct: buySell?.sellPct ?? null,
    buySellWindow: buySell?.window ?? null,
    uniqueBuyersM5: s.txns.m5?.buyers ?? null,
    // Unique wallets are not additive across sub-windows (a wallet active in several 5-minute slices
    // counts once in h1), so this ratio reads slightly high; it is still a fair relative signal.
    buyerAcceleration: acceleration(
      s.txns.m5?.buyers ?? null,
      s.txns.h1?.buyers ?? null,
      MIN_H1_BUYERS_FOR_ACCEL,
      windowAge,
    ),
    holdersGrowthPct: holders?.pct ?? null,
    holdersGrowthWindowMin: holders?.minutes ?? null,
    liquidityChangePct: liquidity?.pct ?? null,
    momentumScore: momentumScore(s, windowAge ?? ageMinutes),
    volatilityProxy: volatilityProxy(s),
    avgTradeUsd,
    largeWalletFlow: largeWalletFlow(avgTradeUsd, h1Txns, s.liquidityUsd),
    volumeToLiquidity: volumeToLiquidity(s, ageMinutes),
    illiquidity: illiquidity(s),
  };
}

export function toCardMetrics(s: TokenSnapshot, m: DerivedMetrics): CardMetrics {
  const volumeWindow: TimeWindow | null = s.volumeUsd.h1 != null ? 'h1' : s.volumeUsd.h24 != null ? 'h24' : null;
  return {
    priceUsd: s.priceUsd,
    marketCapUsd: s.marketCapUsd ?? s.fdvUsd,
    mcIsFdv: s.marketCapUsd == null && s.fdvUsd != null,
    liquidityUsd: s.liquidityUsd,
    volumeUsd: volumeWindow ? (s.volumeUsd[volumeWindow] ?? null) : null,
    volumeWindow,
    txPerMin: m.txPerMin,
    buyPct: m.buyPct,
    sellPct: m.sellPct,
    holders: s.holders,
    holdersGrowthPct: m.holdersGrowthPct,
    priceChangeH1Pct: s.priceChangePct.h1 ?? null,
    ageMinutes: m.ageMinutes,
  };
}

/* ───────────── building blocks ───────────── */

function txTotal(t: TxCounts | undefined): number | null {
  if (!t || t.buys == null || t.sells == null) return null;
  return t.buys + t.sells;
}

/**
 * How long the pool behind the per-window figures has existed. The windows (txns,
 * volume, price change) come from ONE pool, which can be much younger than the token
 * (a launchpad coin that graduated to its AMM pool minutes ago): its "h1" then holds
 * only the pool's minutes. Uses the pool's creation time; without it, the token's age
 * stands in only once it covers the whole hour (no window can be truncated then, though
 * a younger pool cannot be ruled out). Otherwise null: the window span is unknown.
 */
export function windowAgeMinutes(s: TokenSnapshot, tokenAgeMinutes: number | null, now: number): number | null {
  const poolAge = s.pairCreatedAt != null ? Math.max(0, (now - s.pairCreatedAt) / MINUTE_MS) : null;
  if (poolAge != null) return tokenAgeMinutes != null ? Math.min(poolAge, tokenAgeMinutes) : poolAge;
  return tokenAgeMinutes != null && tokenAgeMinutes >= 60 ? tokenAgeMinutes : null;
}

/**
 * Minutes of real activity a rolling window can contain. A pool that is 12 minutes
 * old has at most 12 minutes of "h1" data; dividing by 60 would understate its
 * hourly rate and fake an acceleration.
 */
function coveredMinutes(windowMinutes: number, ageMinutes: number | null): number {
  if (ageMinutes == null) return windowMinutes;
  return clamp(ageMinutes, 1, windowMinutes);
}

/**
 * Rate over the last 5 minutes divided by the average rate over the last hour, both
 * over the time the pool has existed. Unknown pool age → null: assuming a full hour
 * for a 5-minute-old pool would report its launch as a 12x acceleration.
 */
function acceleration(m5: number | null, h1: number | null, minH1: number, windowAge: number | null): number | null {
  if (m5 == null || h1 == null || h1 < minH1 || windowAge == null) return null;
  const hourlyRate = h1 / coveredMinutes(60, windowAge);
  return m5 / coveredMinutes(5, windowAge) / hourlyRate;
}

/**
 * Two liquidity readings belong to one series only when they describe the same pool,
 * come from the same provider and were valued the same way (reported vs quote-backed).
 * Anything else — the main pool switching, a GeckoTerminal reading next to a DexScreener
 * one, a reading crossing the quote-backing cap — is a different measurement, not growth.
 */
function sameLiquiditySeries(a: TokenSnapshot, b: TokenSnapshot): boolean {
  if (a.pairAddress == null || b.pairAddress == null) return false;
  if (addressKey(a.pairAddress) !== addressKey(b.pairAddress)) return false;
  if (a.liquiditySource == null || a.liquiditySource !== b.liquiditySource) return false;
  return (a.liquidityAdjusted === true) === (b.liquidityAdjusted === true);
}

function buySellShare(s: TokenSnapshot): { buyPct: number; sellPct: number; window: TimeWindow } | null {
  for (const window of BUY_SHARE_WINDOWS) {
    const t = s.txns[window];
    const total = txTotal(t);
    if (t?.buys == null || total == null || total < MIN_TXNS_FOR_BUY_SHARE) continue;
    const buyPct = (t.buys / total) * 100;
    return { buyPct, sellPct: 100 - buyPct, window };
  }
  return null;
}

/**
 * Change of a value between the current snapshot and the oldest of our own
 * snapshots from the last hour that is at least 3 minutes older.
 */
function growthFromHistory(
  current: TokenSnapshot,
  history: TokenSnapshot[],
  pick: (s: TokenSnapshot) => number | null,
  comparable: (a: TokenSnapshot, b: TokenSnapshot) => boolean = () => true,
): { pct: number; minutes: number } | null {
  const value = pick(current);
  if (value == null) return null;
  let ref: { ts: number; value: number } | null = null;
  for (const h of history) {
    const v = pick(h);
    if (v == null || v <= 0 || !comparable(h, current)) continue;
    if (h.ts < current.ts - GROWTH_LOOKBACK_MS || h.ts > current.ts - GROWTH_MIN_SPAN_MS) continue;
    if (!ref || h.ts < ref.ts) ref = { ts: h.ts, value: v };
  }
  if (!ref) return null;
  return { pct: ((value - ref.value) / ref.value) * 100, minutes: (current.ts - ref.ts) / MINUTE_MS };
}

function momentumScore(s: TokenSnapshot, ageMinutes: number | null): number | null {
  let sum = 0;
  let weights = 0;
  for (const c of MOMENTUM_COMPONENTS) {
    const pct = s.priceChangePct[c.window];
    if (pct == null || (ageMinutes != null && ageMinutes < c.minutes)) continue;
    sum += c.weight * Math.tanh(pct / c.scale);
    weights += c.weight;
  }
  if (weights === 0) return null;
  return clamp((sum / weights) * 100, -100, 100);
}

/**
 * Crude realized-volatility proxy. Each window's price change is rescaled to a
 * one-hour horizon with the random-walk rule σ_T ∝ √T (m5 × √12, h6 ÷ √6) and the
 * population standard deviation across the rescaled values is returned. It
 * captures how inconsistent the moves are across horizons, not true tick-level
 * volatility; it needs at least two windows.
 */
function volatilityProxy(s: TokenSnapshot): number | null {
  const scaled: number[] = [];
  const { m5, h1, h6 } = s.priceChangePct;
  if (m5 != null) scaled.push(m5 * Math.sqrt(12));
  if (h1 != null) scaled.push(h1);
  if (h6 != null) scaled.push(h6 / Math.sqrt(6));
  if (scaled.length < 2) return null;
  const mean = scaled.reduce((a, b) => a + b, 0) / scaled.length;
  const variance = scaled.reduce((a, b) => a + (b - mean) ** 2, 0) / scaled.length;
  return Math.sqrt(variance);
}

function largeWalletFlow(
  avgTradeUsd: number | null,
  h1Txns: number | null,
  liquidityUsd: number | null,
): DerivedMetrics['largeWalletFlow'] {
  if (avgTradeUsd == null || h1Txns == null || h1Txns < MIN_H1_TXNS_FOR_WALLET_FLOW) return null;
  const highThreshold = Math.max(1500, liquidityUsd != null ? liquidityUsd * 0.01 : 0);
  if (avgTradeUsd >= highThreshold) return 'high';
  if (avgTradeUsd < 150) return 'low';
  return 'normal';
}

function volumeToLiquidity(s: TokenSnapshot, ageMinutes: number | null): number | null {
  if (s.liquidityUsd == null || s.liquidityUsd <= 0) return null;
  const window = volumeToLiquidityWindow(s, ageMinutes);
  const volume = window ? (s.volumeUsd[window] ?? null) : null;
  return volume != null ? volume / s.liquidityUsd : null;
}

/** Which volume window `volumeToLiquidity` uses: h1 (else h24) under 2 h of age, h24 otherwise. */
export function volumeToLiquidityWindow(s: TokenSnapshot, ageMinutes: number | null): 'h1' | 'h24' | null {
  const young = ageMinutes != null && ageMinutes < YOUNG_TOKEN_MINUTES;
  if (young && s.volumeUsd.h1 != null) return 'h1';
  return s.volumeUsd.h24 != null ? 'h24' : null;
}

function illiquidity(s: TokenSnapshot): number | null {
  const change = s.priceChangePct.h1;
  const volume = s.volumeUsd.h1;
  if (change == null || volume == null || volume < MIN_H1_VOLUME_FOR_ILLIQUIDITY_USD) return null;
  return Math.abs(change) / (volume / 1e6);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
