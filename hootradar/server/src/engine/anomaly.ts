import type {
  AnomalySignal,
  DerivedMetrics,
  Detection,
  Severity,
  SignalCode,
  TimeWindow,
  TokenSnapshot,
} from '../../../shared/types.js';

export interface DetectOpts {
  thresholds: Record<Severity, number>;
  minLiquidityUsd: number;
  minVolumeH1Usd: number;
  /** mentions of the token in the last ~2 h (null/undefined = not measured) */
  socialMentions?: number | null;
}

/** Maximum contribution of each signal to the 0-100 score (the sum exceeds 100 and is capped). */
export const SIGNAL_MAX_WEIGHTS: Readonly<Record<SignalCode, number>> = {
  volume_surge: 22,
  tx_acceleration: 16,
  buyer_surge: 14,
  holder_growth: 14,
  liquidity_growth: 8,
  momentum: 12,
  buy_pressure: 8,
  large_wallet_flow: 6,
  social_attention: 8,
  fresh_launch: 6,
};

const MAX_AGE_MINUTES = 7 * 24 * 60;

const WINDOW_LABEL: Record<TimeWindow, string> = { m5: '5m', m15: '15m', m30: '30m', h1: '1h', h6: '6h', h24: '24h' };

/** A signal before weighting: `strength` is 0..1 of the signal's maximum weight. */
interface Scored {
  code: SignalCode;
  strength: number;
  value: number;
  label: string;
}

/**
 * Scores how anomalous a token looks right now. Every signal contributes along a
 * linear ramp between the level where it starts to matter and the level where it
 * earns its full weight, so the score is continuous and monotonic in each input.
 * Pure and deterministic.
 */
export function detectAnomalies(s: TokenSnapshot, m: DerivedMetrics, o: DetectOpts): Detection {
  const rejected = gateReasons(s, m, o);
  const scored = [
    volumeSurge(m),
    txAcceleration(m),
    buyerSurge(m),
    holderGrowth(m),
    liquidityGrowth(m),
    momentum(s, m),
    buyPressure(m),
    largeWalletFlow(m),
    socialAttention(o.socialMentions ?? null),
    freshLaunch(m),
  ].filter((x): x is Scored => x !== null && x.strength > 0);

  const total = scored.reduce((sum, x) => sum + SIGNAL_MAX_WEIGHTS[x.code] * x.strength, 0);
  const score = Math.round(Math.min(100, total));
  const signals: AnomalySignal[] = scored
    .map((x) => ({
      code: x.code,
      label: x.label,
      value: round(x.value, 2),
      weight: round(SIGNAL_MAX_WEIGHTS[x.code] * x.strength, 1),
    }))
    .sort((a, b) => b.weight - a.weight);

  return { score, severity: rejected.length ? null : severityFor(score, o.thresholds), signals, rejected };
}

export function severityFor(score: number, t: Record<Severity, number>): Severity | null {
  if (score >= t.BREAKING) return 'BREAKING';
  if (score >= t.ALERT) return 'ALERT';
  if (score >= t.WATCH) return 'WATCH';
  return null;
}

/* ───────────── gates ───────────── */

function gateReasons(s: TokenSnapshot, m: DerivedMetrics, o: DetectOpts): string[] {
  const reasons: string[] = [];
  if (s.liquidityUsd == null) reasons.push('Liquidity unknown');
  else if (s.liquidityUsd < o.minLiquidityUsd)
    reasons.push(`Liquidity ${usd(s.liquidityUsd)} below ${usd(o.minLiquidityUsd)} minimum`);

  const volumeH1 = s.volumeUsd.h1 ?? null;
  if (volumeH1 == null) reasons.push('1h volume unknown');
  else if (volumeH1 < o.minVolumeH1Usd) reasons.push(`1h volume ${usd(volumeH1)} below ${usd(o.minVolumeH1Usd)} minimum`);

  if (s.security?.honeypot === 'yes') reasons.push('Flagged as honeypot');
  if (m.ageMinutes != null && m.ageMinutes > MAX_AGE_MINUTES)
    reasons.push(`Older than 7 days (${(m.ageMinutes / 1440).toFixed(1)}d)`);
  return reasons;
}

/* ───────────── signals ───────────── */

function volumeSurge(m: DerivedMetrics): Scored | null {
  const x = m.volumeAcceleration;
  if (x == null) return null;
  return { code: 'volume_surge', strength: ramp(x, 2, 6), value: x, label: `Volume ${mult(x)}x vs 1h avg` };
}

function txAcceleration(m: DerivedMetrics): Scored | null {
  const x = m.txAcceleration;
  if (x == null) return null;
  return { code: 'tx_acceleration', strength: ramp(x, 2, 6), value: x, label: `Trades ${mult(x)}x vs 1h avg` };
}

/** Either a rising rate of new buyers or a large absolute crowd of buyers in 5 minutes. */
function buyerSurge(m: DerivedMetrics): Scored | null {
  const accel = m.buyerAcceleration;
  const crowd = m.uniqueBuyersM5;
  const byAccel: Scored | null =
    accel != null
      ? { code: 'buyer_surge', strength: ramp(accel, 2, 6), value: accel, label: `Unique buyers ${mult(accel)}x vs 1h avg` }
      : null;
  const byCrowd: Scored | null =
    crowd != null
      ? { code: 'buyer_surge', strength: ramp(crowd, 40, 120), value: crowd, label: `${crowd} unique buyers in 5m` }
      : null;
  if (!byAccel) return byCrowd;
  if (!byCrowd) return byAccel;
  return byCrowd.strength > byAccel.strength ? byCrowd : byAccel;
}

function holderGrowth(m: DerivedMetrics): Scored | null {
  const x = m.holdersGrowthPct;
  if (x == null) return null;
  const span = m.holdersGrowthWindowMin != null ? ` / ${Math.round(m.holdersGrowthWindowMin)}m` : '';
  return { code: 'holder_growth', strength: ramp(x, 10, 50), value: x, label: `${signedPct(x)} holders${span}` };
}

function liquidityGrowth(m: DerivedMetrics): Scored | null {
  const x = m.liquidityChangePct;
  if (x == null) return null;
  return { code: 'liquidity_growth', strength: ramp(x, 15, 60), value: x, label: `Liquidity ${signedPct(x)} within 1h` };
}

function momentum(s: TokenSnapshot, m: DerivedMetrics): Scored | null {
  const x = m.momentumScore;
  if (x == null) return null;
  const h1 = s.priceChangePct.h1;
  const detail = h1 != null ? ` (1h ${signedPct(h1)})` : '';
  return { code: 'momentum', strength: ramp(x, 35, 80), value: x, label: `Momentum ${Math.round(x)}/100${detail}` };
}

function buyPressure(m: DerivedMetrics): Scored | null {
  const x = m.buyPct;
  if (x == null || m.buySellWindow == null) return null;
  return {
    code: 'buy_pressure',
    strength: ramp(x, 62, 80),
    value: x,
    label: `${Math.round(x)}% buys (${WINDOW_LABEL[m.buySellWindow]})`,
  };
}

function largeWalletFlow(m: DerivedMetrics): Scored | null {
  if (m.largeWalletFlow !== 'high' || m.avgTradeUsd == null) return null;
  return { code: 'large_wallet_flow', strength: 1, value: m.avgTradeUsd, label: `Avg trade ${usd(m.avgTradeUsd)} (large)` };
}

function socialAttention(mentions: number | null): Scored | null {
  if (mentions == null) return null;
  return { code: 'social_attention', strength: ramp(mentions, 3, 15), value: mentions, label: `${mentions} mentions in 2h` };
}

/** Busy first hour of trading; full weight under 30 minutes, fading out by 60. */
function freshLaunch(m: DerivedMetrics): Scored | null {
  const age = m.ageMinutes;
  const rate = m.txPerMin;
  if (age == null || rate == null || age > 60) return null;
  return {
    code: 'fresh_launch',
    strength: ramp(rate, 5, 10) * (1 - ramp(age, 30, 60)),
    value: age,
    label: `Launched ${Math.round(age)}m ago · ${mult(rate)} tx/min`,
  };
}

/* ───────────── helpers ───────────── */

/** 0 at `lo`, 1 at `hi`, linear in between. */
function ramp(x: number, lo: number, hi: number): number {
  return Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function mult(x: number): string {
  return x >= 10 ? x.toFixed(0) : x.toFixed(1);
}

function signedPct(x: number): string {
  const digits = Math.abs(x) >= 10 ? 0 : 1;
  return `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%`;
}

function usd(x: number): string {
  return `$${Math.round(x).toLocaleString('en-US')}`;
}
