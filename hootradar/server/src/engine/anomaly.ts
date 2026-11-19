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
  /**
   * BREAKING needs a market of real size: below either minimum the severity is held
   * at ALERT (live: a $31K-cap token with $12K of 1 h volume went out as BREAKING).
   */
  breakingMinLiquidityUsd: number;
  breakingMinVolumeH1Usd: number;
  /** mentions of the token in the last ~2 h (null/undefined = not measured) */
  socialMentions?: number | null;
  /**
   * Launch-traction ramp in USD of volume per minute (onset → full weight), e.g. the
   * token's chain baseline (see baselines.ts). Default: the global calibration.
   */
  launchRamp?: LaunchRamp;
}

export interface LaunchRamp {
  onsetPerMin: number;
  fullPerMin: number;
}

/**
 * Global launch-traction calibration (Oct 2026, all four chains): the median young
 * token that clears the market gates trades ~$10K a minute, the top decile ~$40K.
 */
export const DEFAULT_LAUNCH_RAMP: Readonly<LaunchRamp> = { onsetPerMin: 10_000, fullPerMin: 50_000 };

/** Holder concentration at or above this keeps a token out of BREAKING (two such tokens rugged minutes after publication). */
export const BREAKING_MAX_TOP10_PCT = 80;
/** Liquidity down this much (or more) against our own history of the same pool: pulled, never published. */
export const LIQUIDITY_PULLED_PCT = -50;

/**
 * Maximum contribution of each signal to the 0-100 score (the sum exceeds 100 and is capped).
 *
 * Flow anomalies (volume / trades vs the token's own 1 h average) carry the most
 * weight. They cannot fire during a token's first hour, when the 1 h window holds
 * nothing but the launch itself (the ratio is ≈1 by construction), so `fresh_launch`
 * stands in for them on young tokens with a comparable weight, measured against
 * absolute traction instead of a baseline the token does not have yet.
 */
export const SIGNAL_MAX_WEIGHTS: Readonly<Record<SignalCode, number>> = {
  volume_surge: 30,
  tx_acceleration: 20,
  buyer_surge: 22,
  holder_growth: 18,
  liquidity_growth: 12,
  momentum: 16,
  buy_pressure: 10,
  large_wallet_flow: 8,
  social_attention: 10,
  fresh_launch: 34,
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
    freshLaunch(s, m, o.launchRamp ?? DEFAULT_LAUNCH_RAMP),
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

  const byScore = rejected.length ? null : severityFor(score, o.thresholds);
  const caps = byScore === 'BREAKING' ? breakingCaps(s, o) : [];
  const severity: Severity | null = caps.length ? 'ALERT' : byScore;
  return { score, severity, signals, rejected, ...(caps.length ? { caps } : {}) };
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
  if (m.liquidityChangePct != null && m.liquidityChangePct <= LIQUIDITY_PULLED_PCT)
    reasons.push(`Liquidity pulled (${signedPct(m.liquidityChangePct)} within 1h)`);
  return reasons;
}

/**
 * Why a score in BREAKING range is held at ALERT: the market is too small for the
 * label (one wallet can move it), or the token carries a structural rug risk.
 * Unknown market values never cap: they are not evidence. Unknown holder
 * concentration does: BREAKING is a claim that the move is worth trusting, and
 * live, two of three BREAKINGs were <15 min old with no holder data yet (one
 * rugged minutes later). The story still publishes immediately, as ALERT.
 */
function breakingCaps(s: TokenSnapshot, o: DetectOpts): string[] {
  const caps: string[] = [];
  const liquidity = s.liquidityUsd;
  if (liquidity != null && liquidity < o.breakingMinLiquidityUsd)
    caps.push(`Liquidity ${usd(liquidity)} below the ${usd(o.breakingMinLiquidityUsd)} BREAKING minimum`);
  const volumeH1 = s.volumeUsd.h1 ?? null;
  if (volumeH1 != null && volumeH1 < o.breakingMinVolumeH1Usd)
    caps.push(`1h volume ${usd(volumeH1)} below the ${usd(o.breakingMinVolumeH1Usd)} BREAKING minimum`);
  if (s.top10HolderPct == null) caps.push('Holder concentration not available yet');
  else if (s.top10HolderPct >= BREAKING_MAX_TOP10_PCT)
    caps.push(`Top 10 holders own ${Math.round(s.top10HolderPct)}% of supply`);
  if (s.security?.mintAuthority === true) caps.push('Mint authority enabled');
  if (s.security?.freezeAuthority === true) caps.push('Freeze authority enabled');
  return caps;
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

/**
 * Either a rising rate of new buyers or a large absolute crowd of buyers in 5 minutes.
 * Crowd ramp from live data: among tokens clearing the market gates the median has
 * ~25 unique buyers in 5 minutes and the top decile ~190.
 */
function buyerSurge(m: DerivedMetrics): Scored | null {
  const accel = m.buyerAcceleration;
  const crowd = m.uniqueBuyersM5;
  const byAccel: Scored | null =
    accel != null
      ? { code: 'buyer_surge', strength: ramp(accel, 2, 6), value: accel, label: `Unique buyers ${mult(accel)}x vs 1h avg` }
      : null;
  const byCrowd: Scored | null =
    crowd != null
      ? { code: 'buyer_surge', strength: ramp(crowd, 50, 200), value: crowd, label: `${crowd.toLocaleString('en-US')} unique buyers in 5m` }
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

/**
 * Price momentum is phased in over the launch hour: a 10-minute-old token is
 * routinely ±50% in five minutes while its price is still being discovered, so
 * the same reading says far less than it does on a token with an hour of history.
 * Launch traction is scored by `fresh_launch` instead.
 */
function momentum(s: TokenSnapshot, m: DerivedMetrics): Scored | null {
  const x = m.momentumScore;
  if (x == null) return null;
  const h1 = s.priceChangePct.h1;
  // under an hour of pool history the "1h" change is the move since launch, left out of the score too
  const detail = h1 != null && coversHour(m) ? ` (1h ${signedPct(h1)})` : '';
  const maturity = m.ageMinutes == null ? 1 : ramp(m.ageMinutes, 10, 60);
  return {
    code: 'momentum',
    strength: ramp(x, 35, 80) * maturity,
    value: x,
    label: `Momentum ${Math.round(x)}/100${detail}`,
  };
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
  // only mentions of the contract or the distinctive name are counted (see quickMentions)
  return {
    code: 'social_attention',
    strength: ramp(mentions, 3, 15),
    value: mentions,
    label: `${mentions} mentions in 2h (name or contract)`,
  };
}

/**
 * Launch traction: how much real trading a token attracted since it launched.
 * Calibrated on live launches across the four chains (Oct 2026): the median young
 * token that clears the liquidity/volume gates trades ~$10K a minute, the top
 * decile ~$40K. Onset sits at that median and full weight at $50K/min, so only
 * launches well above typical draw attention. Two guards keep it honest: enough
 * separate trades that one wallet cannot fake it, and a few minutes of survival
 * (the first minutes belong to snipers and bots). It fades out between 60 and 90
 * minutes, when the 1 h baseline no longer contains the launch and the flow
 * signals take over.
 */
function freshLaunch(s: TokenSnapshot, m: DerivedMetrics, r: LaunchRamp): Scored | null {
  const age = m.ageMinutes;
  const volume = s.volumeUsd.h1 ?? null;
  const trades = txTotal(s.txns.h1);
  if (age == null || volume == null || trades == null || age > LAUNCH_FADE_END_MIN) return null;
  const perMinute = launchVolumePerMinute(volume, age, m.windowAgeMinutes ?? null);
  const strength =
    ramp(perMinute, r.onsetPerMin, r.fullPerMin) *
    ramp(trades, 30, 150) *
    ramp(age, 2, 10) *
    (1 - ramp(age, LAUNCH_FADE_START_MIN, LAUNCH_FADE_END_MIN));
  return {
    code: 'fresh_launch',
    strength,
    value: perMinute,
    label: `Launched ${Math.round(age)}m ago · ${usdShort(volume)} volume, ${trades.toLocaleString('en-US')} trades`,
  };
}

const LAUNCH_FADE_START_MIN = 60;
const LAUNCH_FADE_END_MIN = 90;

/**
 * Average 1 h volume per minute over the minutes the window really holds: the pool's
 * life when it is younger than an hour (a pool younger than its token holds fewer
 * minutes than the token's age), otherwise the full hour.
 */
export function launchVolumePerMinute(volumeH1: number, tokenAgeMinutes: number, windowAgeMinutes: number | null): number {
  const minutes = Math.min(60, Math.max(1, windowAgeMinutes ?? tokenAgeMinutes));
  return volumeH1 / minutes;
}

/** The 1 h window holds a full hour of the measured pool (unknown pool age: the token's age decides). */
function coversHour(m: DerivedMetrics): boolean {
  const age = m.windowAgeMinutes ?? m.ageMinutes;
  return age == null || age >= 60;
}

function txTotal(t: TokenSnapshot['txns'][TimeWindow]): number | null {
  return t?.buys != null && t.sells != null ? t.buys + t.sells : null;
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

/** "$156K", "$1.2M" */
function usdShort(x: number): string {
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${Math.round(x / 1e3)}K`;
  return `$${Math.round(x)}`;
}
