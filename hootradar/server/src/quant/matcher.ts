import {
  QUANT_DISCLAIMER,
  type DerivedMetrics,
  type MarketRegime,
  type QuantFactor,
  type QuantMatch,
  type QuantResult,
  type TimeWindow,
  type TokenSnapshot,
} from '../../../shared/types.js';
import { METHODOLOGIES } from './library.js';

/* ─────────────────────────── signature model ─────────────────────────── */

interface Ctx {
  s: TokenSnapshot;
  m: DerivedMetrics;
  regime: MarketRegime;
  socialMentions: number | null;
}

interface FeatureSpec {
  feature: string;
  label: string;
  weight: number;
  /** null = no data; the feature then leaves the denominator and lowers coverage */
  value: (c: Ctx) => number | null;
  /** 0-1 degree to which the value satisfies the methodology (only called with finite values) */
  fit: (v: number, c: Ctx) => number;
  /** the defining measurement of the methodology: without it the methodology is not scored at all */
  required?: boolean;
}

interface Signature {
  /** what follows "Current conditions resemble …" */
  lead: string;
  /** optional closing clause, e.g. what a risk overlay would do */
  tail?: string;
  features: FeatureSpec[];
  /** short evidence clauses built from real values; `fit` looks up a feature's fit by name */
  evidence: (c: Ctx, fit: (feature: string) => number) => string[];
}

/** Coverage at which the score is no longer capped. */
const FULL_COVERAGE = 0.6;
/** Wording thresholds for the rationale sentence. */
const STRONG_SCORE = 50;
const WEAK_SCORE = 25;
/** Minimum fit for a feature to be cited as evidence in the rationale. */
const EVIDENCE_FIT = 0.25;

/** Risk-flag thresholds. */
const MIN_SAFE_LIQUIDITY_USD = 10_000;
const MAX_TOP10_PCT = 50;
const MAX_DEV_PCT = 10;
const MIN_AGE_MINUTES = 15;
const MAX_VOLUME_TO_LIQUIDITY = 20;

const WINDOW_MINUTES: Record<TimeWindow, number> = { m5: 5, m15: 15, m30: 30, h1: 60, h6: 360, h24: 1440 };
/**
 * Providers report a token's whole life for windows longer than its age (a 10-minute-old
 * token shows the same change for 1h, 6h and 24h). A window counts only when the token
 * has existed for at least this share of it.
 */
const MIN_WINDOW_SPAN = 0.75;

/* ─────────────────────────── fit helpers ─────────────────────────── */

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** Smoothstep from 0 at `from` to 1 at `to`; works in either direction (from > to = decreasing). */
export function ramp(x: number, from: number, to: number): number {
  if (from === to) return x >= to ? 1 : 0;
  const t = clamp01((x - from) / (to - from));
  return t * t * (3 - 2 * t);
}

/** Ramp on a log10 scale, for quantities spanning orders of magnitude (USD, ratios). */
function logRamp(x: number, from: number, to: number): number {
  if (x <= 0) return to < from ? 1 : 0;
  return ramp(Math.log10(x), Math.log10(from), Math.log10(to));
}

const finite = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** True when the token is old enough (or of unknown age) for the window to mean what it says. */
function windowIsReal(c: Ctx, w: TimeWindow): boolean {
  const age = finite(c.m.ageMinutes);
  return age == null || age >= WINDOW_MINUTES[w] * MIN_WINDOW_SPAN;
}

/** Price change over a window, or null when unknown or when the token is younger than the window. */
const pc = (c: Ctx, w: TimeWindow): number | null => (windowIsReal(c, w) ? finite(c.s.priceChangePct[w]) : null);

/**
 * The momentum score and volatility proxy blend the m5/h1/h6 windows; while h1 is really
 * "since launch" they describe the launch, not a trend or a volatility regime.
 */
const momentum = (c: Ctx): number | null => (windowIsReal(c, 'h1') ? finite(c.m.momentumScore) : null);
const volatility = (c: Ctx): number | null => (windowIsReal(c, 'h1') ? finite(c.m.volatilityProxy) : null);

/** Market cap, falling back to FDV (new tokens usually have their whole supply circulating). */
const sizeUsd = (c: Ctx): number | null => finite(c.s.marketCapUsd) ?? finite(c.s.fdvUsd);

/** Price change from 6h ago to 1h ago, derived exactly from the two cumulative windows. */
function earlierMove(c: Ctx): number | null {
  const h1 = pc(c, 'h1');
  const h6 = pc(c, 'h6');
  if (h1 == null || h6 == null || h1 <= -100) return null;
  return ((1 + h6 / 100) / (1 + h1 / 100) - 1) * 100;
}

/*
 * Gates. Secondary features of a signature only count to the extent that its primary
 * condition holds, so a flat token cannot collect credit for, say, "consistency".
 * They are smooth (0-1) multipliers rather than on/off switches.
 */

/** Strength of an up-trend: rising over 1h, and not falling over 6h when that window is known. */
function uptrendStrength(c: Ctx): number {
  const h1 = pc(c, 'h1');
  const h6 = pc(c, 'h6');
  if (h1 == null || (h6 != null && h6 <= 0)) return 0;
  return ramp(h1, 0, 10);
}

/**
 * Positive recent performance (composite momentum, else 24h change). Size and liquidity
 * only describe the factor profile when the momentum leg is present: a small coin that
 * is collapsing is not "small-cap momentum".
 */
const risingStrength = (c: Ctx): number => ramp(momentum(c) ?? pc(c, 'h24') ?? 0, 0, 20);

/** Buy-side imbalance. Only buying is a long setup; heavy selling feeds the risk overlay. */
const buyImbalance = (c: Ctx): number => ramp(finite(c.m.buyPct) ?? 50, 55, 75);

/** How "extreme" the 1h move is in reversal terms. */
const extremeness = (c: Ctx): number => ramp(Math.abs(pc(c, 'h1') ?? 0), 10, 30);

/** Token change over its longest real window: the stand-in for "price above its moving average". */
const trendReference = (c: Ctx): number | null => pc(c, 'h6') ?? pc(c, 'h1');
const aboveTrend = (c: Ctx): number => ramp(trendReference(c) ?? 0, 0, 10);

/** Regime statistics are meaningless when the regime itself is unknown. */
const regimeValue = (c: Ctx, v: number | null): number | null => (c.regime.label === 'unknown' ? null : finite(v));

/**
 * Structural red flags visible in the security data: only facts count. An unknown
 * honeypot status (or authority) is missing data, never a red flag; null when no
 * security fact is known at all (the feature then lowers coverage instead).
 */
function securityRedFlags(c: Ctx): number | null {
  const sec = c.s.security;
  if (!sec) return null;
  const known =
    sec.mintAuthority !== null || sec.freezeAuthority !== null || sec.honeypot !== 'unknown' || sec.devHoldingPct != null;
  if (!known) return null;
  let n = 0;
  if (sec.mintAuthority === true) n++;
  if (sec.freezeAuthority === true) n++;
  if (sec.honeypot === 'yes') n++;
  if (sec.devHoldingPct != null && sec.devHoldingPct > MAX_DEV_PCT) n++;
  return n;
}

/**
 * Worst cumulative change across the long windows: a drawdown proxy without a full price
 * path. Unlike the trend features this keeps windows longer than the token's life: "down
 * 80% since launch" is exactly what a drawdown rule must see, it is only worded differently.
 */
function worstChange(c: Ctx): { pct: number; span: string } | null {
  let worst: { pct: number; span: string } | null = null;
  for (const window of ['h1', 'h6', 'h24'] as const) {
    const pct = finite(c.s.priceChangePct[window]);
    if (pct == null || (worst != null && pct >= worst.pct)) continue;
    worst = { pct, span: windowIsReal(c, window) ? `over ${WINDOW_TEXT[window]}` : 'since launch' };
  }
  return worst;
}

/* ─────────────────────────── text helpers ─────────────────────────── */

const WINDOW_TEXT: Record<TimeWindow, string> = { m5: '5m', m15: '15m', m30: '30m', h1: '1h', h6: '6h', h24: '24h' };

function num(n: number): string {
  const abs = Math.abs(n);
  return abs.toLocaleString('en-US', { maximumFractionDigits: abs >= 10 ? 0 : 1 });
}
/** "a 60" / "an 82": the article for a number as it is read aloud ("eighty", "eleven", "eighteen"). */
const an = (numberText: string): string => `${/^(8|1[18](\D|$))/.test(numberText) ? 'an' : 'a'} ${numberText}`;
const signedPct = (n: number): string => `${n < 0 ? '-' : '+'}${num(n)}%`;
const times = (n: number): string => `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}x`;

function usd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/** "price up 34% over 1h and 61% over 6h"; the direction word is repeated only when it changes. */
function priceMoves(moves: Array<[TimeWindow, number | null]>): string | null {
  const known = moves.filter((x): x is [TimeWindow, number] => x[1] != null);
  if (!known.length) return null;
  let lastDir = '';
  const parts = known.map(([w, v]) => {
    const dir = v >= 0 ? 'up' : 'down';
    const text = `${dir === lastDir ? '' : `${dir} `}${num(v)}% over ${WINDOW_TEXT[w]}`;
    lastDir = dir;
    return text;
  });
  const last = parts.pop();
  return `price ${parts.length ? `${parts.join(', ')} and ${last}` : last}`;
}

/* ─────────────────────────── signatures ─────────────────────────── */

const SIGNATURES: Record<string, Signature> = {
  'ts-momentum': {
    lead: 'the setup that time-series momentum looks for',
    features: [
      {
        feature: 'priceChangeH1',
        label: '1h price change',
        weight: 2,
        required: true,
        value: (c) => pc(c, 'h1'),
        fit: (v) => ramp(v, 0, 30),
      },
      {
        feature: 'priceChangeH6',
        label: '6h price change',
        weight: 2,
        value: (c) => pc(c, 'h6'),
        fit: (v) => ramp(v, 0, 60),
      },
      {
        feature: 'weakerOfH1H6',
        label: 'Weaker of 1h / 6h change (alignment)',
        weight: 2,
        value: (c) => {
          const h1 = pc(c, 'h1');
          const h6 = pc(c, 'h6');
          return h1 != null && h6 != null ? Math.min(h1, h6) : null;
        },
        fit: (v) => ramp(v, 0, 20),
      },
      {
        feature: 'momentumScore',
        label: 'Composite momentum score',
        weight: 3,
        value: momentum,
        fit: (v) => ramp(v, 10, 60),
      },
      {
        feature: 'priceChangeM5',
        label: '5m price change (no reversal)',
        weight: 1,
        value: (c) => pc(c, 'm5'),
        fit: (v, c) => ramp(v, -2, 3) * uptrendStrength(c),
      },
    ],
    evidence: (c, fit) => {
      const out: string[] = [];
      const moves = priceMoves([['h1', pc(c, 'h1')], ['h6', pc(c, 'h6')]]);
      if (moves && (fit('priceChangeH1') >= EVIDENCE_FIT || fit('priceChangeH6') >= EVIDENCE_FIT)) out.push(moves);
      const m5 = pc(c, 'm5');
      if (m5 != null && m5 > 0 && fit('weakerOfH1H6') >= EVIDENCE_FIT) out.push(`with aligned short-term trend (${signedPct(m5)} over 5m)`);
      const ms = momentum(c);
      if (!out.length && ms != null && fit('momentumScore') >= EVIDENCE_FIT) out.push(`a composite momentum score of ${ms.toFixed(0)}`);
      return out;
    },
  },

  'crypto-size-momentum': {
    lead: 'the profile the crypto size and momentum factors favour',
    features: [
      {
        feature: 'marketCapUsd',
        label: 'Market cap (FDV if unknown)',
        weight: 2,
        value: sizeUsd,
        fit: (v, c) => logRamp(v, 2e7, 3e5) * risingStrength(c),
      },
      {
        feature: 'priceChangeH24',
        label: '24h price change',
        weight: 2,
        value: (c) => pc(c, 'h24'),
        fit: (v) => ramp(v, 0, 100),
      },
      {
        feature: 'momentumScore',
        label: 'Composite momentum score',
        weight: 2,
        value: momentum,
        fit: (v) => ramp(v, 5, 50),
      },
      {
        feature: 'liquidityUsd',
        label: 'Pool liquidity (tradability floor)',
        weight: 1,
        value: (c) => finite(c.s.liquidityUsd),
        fit: (v, c) => logRamp(v, 5e3, 3e4) * risingStrength(c),
      },
    ],
    evidence: (c, fit) => {
      const out: string[] = [];
      const size = sizeUsd(c);
      if (size != null && fit('marketCapUsd') >= EVIDENCE_FIT) {
        out.push(`a small ${usd(size)} ${finite(c.s.marketCapUsd) != null ? 'market cap' : 'FDV'}`);
      }
      const moves = priceMoves([['h24', pc(c, 'h24')]]);
      if (moves && fit('priceChangeH24') >= EVIDENCE_FIT) out.push(moves);
      const ms = momentum(c);
      if (ms != null && fit('momentumScore') >= EVIDENCE_FIT) out.push(`a momentum score of ${ms.toFixed(0)}`);
      return out;
    },
  },

  'short-term-reversal': {
    lead: 'the setup that short-term reversal looks for',
    features: [
      {
        feature: 'priceChangeH1',
        label: 'Size of the 1h move',
        weight: 2,
        required: true,
        value: (c) => pc(c, 'h1'),
        fit: (v) => ramp(Math.abs(v), 20, 80),
      },
      {
        feature: 'counterMoveM5',
        label: '5m move against the 1h trend',
        weight: 2,
        value: (c) => (pc(c, 'h1') != null ? pc(c, 'm5') : null),
        fit: (v, c) => {
          const h1 = pc(c, 'h1') ?? 0;
          return Math.sign(v) !== 0 && Math.sign(v) === -Math.sign(h1) ? ramp(Math.abs(v), 2, 12) * extremeness(c) : 0;
        },
      },
      {
        feature: 'txAcceleration',
        label: 'Transaction pace vs 1h average (fading)',
        weight: 1.5,
        value: (c) => finite(c.m.txAcceleration),
        fit: (v, c) => ramp(v, 1, 0.4) * extremeness(c),
      },
      {
        feature: 'volumeAcceleration',
        label: 'Volume pace vs 1h average (fading)',
        weight: 1,
        value: (c) => finite(c.m.volumeAcceleration),
        fit: (v, c) => ramp(v, 1, 0.4) * extremeness(c),
      },
    ],
    evidence: (c, fit) => {
      const out: string[] = [];
      const h1 = pc(c, 'h1');
      if (h1 != null && fit('priceChangeH1') >= EVIDENCE_FIT) out.push(`an extreme 1h ${h1 >= 0 ? 'rise' : 'drop'} of ${num(h1)}%`);
      const m5 = pc(c, 'm5');
      if (m5 != null && fit('counterMoveM5') >= EVIDENCE_FIT) out.push(`a 5m counter-move of ${signedPct(m5)}`);
      const tx = finite(c.m.txAcceleration);
      if (tx != null && fit('txAcceleration') >= EVIDENCE_FIT) out.push(`trading slowing to ${times(tx)} the hourly pace`);
      return out;
    },
  },

  'trend-following': {
    lead: 'the setup that trend following looks for',
    features: [
      {
        feature: 'priceChangeM5',
        label: '5m price change',
        weight: 1,
        value: (c) => pc(c, 'm5'),
        fit: (v) => ramp(v, -1, 4),
      },
      {
        feature: 'priceChangeH1',
        label: '1h price change',
        weight: 2,
        required: true,
        value: (c) => pc(c, 'h1'),
        fit: (v) => ramp(v, 0, 20),
      },
      {
        feature: 'priceChangeH6',
        label: '6h price change',
        weight: 2,
        value: (c) => pc(c, 'h6'),
        fit: (v) => ramp(v, 0, 40),
      },
      {
        feature: 'earlierMove',
        label: 'Change from 6h ago to 1h ago (trend predates the last hour)',
        weight: 2,
        value: earlierMove,
        fit: (v, c) => ramp(v, 0, 15) * uptrendStrength(c),
      },
      {
        feature: 'volatilityProxy',
        label: 'Consistency across horizons (low dispersion)',
        weight: 1,
        value: volatility,
        fit: (v, c) => ramp(v, 40, 10) * uptrendStrength(c),
      },
    ],
    evidence: (c, fit) => {
      const out: string[] = [];
      const moves = priceMoves([['m5', pc(c, 'm5')], ['h1', pc(c, 'h1')], ['h6', pc(c, 'h6')]]);
      if (moves && fit('priceChangeH1') >= EVIDENCE_FIT) out.push(moves);
      if (fit('earlierMove') >= EVIDENCE_FIT) out.push('with the advance building over several hours rather than in a single spike');
      return out;
    },
  },

  'volume-breakout': {
    lead: 'the setup that a high-volume breakout looks for',
    features: [
      {
        feature: 'volumeAcceleration',
        label: 'Volume pace vs 1h average',
        weight: 3,
        required: true,
        value: (c) => finite(c.m.volumeAcceleration),
        fit: (v) => ramp(v, 1.5, 4),
      },
      {
        feature: 'txAcceleration',
        label: 'Transaction pace vs 1h average',
        weight: 1.5,
        value: (c) => finite(c.m.txAcceleration),
        fit: (v) => ramp(v, 1.3, 3),
      },
      {
        feature: 'priceChangeM5',
        label: '5m price change',
        weight: 2,
        value: (c) => pc(c, 'm5'),
        fit: (v) => ramp(v, 0, 8),
      },
      {
        feature: 'priceChangeH1',
        label: '1h price change',
        weight: 1.5,
        value: (c) => pc(c, 'h1'),
        fit: (v) => ramp(v, 0, 25),
      },
    ],
    evidence: (c, fit) => {
      const out: string[] = [];
      const va = finite(c.m.volumeAcceleration);
      if (va != null && fit('volumeAcceleration') >= EVIDENCE_FIT) out.push(`volume running ${times(va)} its hourly pace`);
      const tx = finite(c.m.txAcceleration);
      if (tx != null && fit('txAcceleration') >= EVIDENCE_FIT) out.push(`transactions at ${times(tx)}`);
      const moves = priceMoves([['m5', pc(c, 'm5')], ['h1', pc(c, 'h1')]]);
      if (moves && (fit('priceChangeM5') >= EVIDENCE_FIT || fit('priceChangeH1') >= EVIDENCE_FIT)) {
        out.push(out.length ? `with ${moves}` : moves);
      }
      return out;
    },
  },

  'volatility-managed': {
    lead: 'what a volatility-managed overlay reacts to',
    tail: 'a reading that calls for scaling exposure down',
    features: [
      {
        feature: 'volatilityProxy',
        label: 'Realised-volatility proxy (pct points)',
        weight: 3,
        value: volatility,
        fit: (v) => ramp(v, 15, 60),
      },
      {
        feature: 'priceChangeM5',
        label: 'Size of the 5m swing',
        weight: 1.5,
        value: (c) => pc(c, 'm5'),
        fit: (v) => ramp(Math.abs(v), 5, 20),
      },
      {
        feature: 'priceChangeH1',
        label: 'Size of the 1h move',
        weight: 1,
        value: (c) => pc(c, 'h1'),
        fit: (v) => ramp(Math.abs(v), 20, 80),
      },
    ],
    evidence: (c, fit) => {
      const out: string[] = [];
      const vol = volatility(c);
      if (vol != null && fit('volatilityProxy') >= EVIDENCE_FIT) out.push(`a realised-volatility proxy of ${vol.toFixed(0)} points`);
      const m5 = pc(c, 'm5');
      if (m5 != null && fit('priceChangeM5') >= EVIDENCE_FIT) out.push(`a ${signedPct(m5)} swing in 5 minutes`);
      const h1 = pc(c, 'h1');
      if (h1 != null && fit('priceChangeH1') >= EVIDENCE_FIT) out.push(`a ${signedPct(h1)} move over 1h`);
      return out;
    },
  },

  'amihud-illiquidity': {
    lead: 'what the Amihud illiquidity measure flags',
    tail: 'price impact and exit risk are high',
    features: [
      {
        feature: 'illiquidity',
        label: 'Amihud ratio (|1h change| per $1M of 1h volume)',
        weight: 3,
        required: true,
        value: (c) => (windowIsReal(c, 'h1') ? finite(c.m.illiquidity) : null),
        fit: (v) => logRamp(v, 30, 600),
      },
      {
        feature: 'liquidityUsd',
        label: 'Pool liquidity (lower = thinner)',
        weight: 2,
        value: (c) => finite(c.s.liquidityUsd),
        fit: (v) => logRamp(v, 1e5, 1e4),
      },
    ],
    evidence: (c, fit) => {
      const out: string[] = [];
      const ratio = windowIsReal(c, 'h1') ? finite(c.m.illiquidity) : null;
      const h1 = pc(c, 'h1');
      const volH1 = finite(c.s.volumeUsd.h1);
      if (ratio != null && fit('illiquidity') >= EVIDENCE_FIT) {
        out.push(
          h1 != null && volH1 != null
            ? `${an(num(h1))}% 1h move on only ${usd(volH1)} of 1h volume (Amihud ratio ${ratio.toFixed(0)})`
            : `an Amihud ratio of ${ratio.toFixed(0)}`,
        );
      }
      const liq = finite(c.s.liquidityUsd);
      if (liq != null && fit('liquidityUsd') >= EVIDENCE_FIT) out.push(`a pool with ${usd(liq)} of liquidity`);
      return out;
    },
  },

  'order-flow-imbalance': {
    lead: 'the setup that order-flow imbalance studies look for',
    features: [
      {
        feature: 'buyPct',
        label: 'Buy share of transactions (%)',
        weight: 3,
        required: true,
        value: (c) => finite(c.m.buyPct),
        fit: (v) => ramp(v, 55, 75),
      },
      {
        feature: 'txPerMin',
        label: 'Transactions per minute behind the buy imbalance',
        weight: 2,
        value: (c) => finite(c.m.txPerMin),
        fit: (v, c) => ramp(v, 1, 10) * buyImbalance(c),
      },
      {
        feature: 'priceChangeM5',
        label: '5m price change confirming the imbalance',
        weight: 1.5,
        value: (c) => pc(c, 'm5'),
        fit: (v, c) => ramp(v, 0, 5) * buyImbalance(c),
      },
    ],
    evidence: (c, fit) => {
      const out: string[] = [];
      const buy = finite(c.m.buyPct);
      if (buy != null && fit('buyPct') >= EVIDENCE_FIT) {
        const window = c.m.buySellWindow ? ` (${WINDOW_TEXT[c.m.buySellWindow]} window)` : '';
        out.push(`${num(buy)}% of transactions are buys${window}`);
      }
      const tpm = finite(c.m.txPerMin);
      if (tpm != null && fit('txPerMin') >= EVIDENCE_FIT) out.push(`at ${num(tpm)} trades per minute`);
      const m5 = pc(c, 'm5');
      if (m5 != null && fit('priceChangeM5') >= EVIDENCE_FIT) out.push(`with price following (${signedPct(m5)} over 5m)`);
      return out;
    },
  },

  'investor-attention': {
    lead: 'the setup that investor-attention research looks for',
    features: [
      {
        feature: 'socialMentions',
        label: 'Recent public mentions',
        weight: 3,
        value: (c) => finite(c.socialMentions),
        fit: (v) => ramp(v, 1, 10),
      },
      {
        feature: 'buyerAcceleration',
        label: 'Unique-buyer pace vs 1h average',
        weight: 2,
        value: (c) => finite(c.m.buyerAcceleration),
        fit: (v) => ramp(v, 1.3, 3.5),
      },
      {
        feature: 'uniqueBuyersM5',
        label: 'Unique buyers in 5m',
        weight: 1,
        value: (c) => finite(c.m.uniqueBuyersM5),
        fit: (v) => ramp(v, 5, 50),
      },
      {
        feature: 'holdersGrowthPct',
        label: 'Holder growth (%)',
        weight: 1.5,
        value: (c) => finite(c.m.holdersGrowthPct),
        fit: (v) => ramp(v, 2, 20),
      },
      {
        feature: 'boosted',
        label: 'Paid promotion (DexScreener boost)',
        weight: 1,
        value: (c) => (c.s.boosted ? 1 : 0),
        fit: (v) => v,
      },
    ],
    evidence: (c, fit) => {
      const out: string[] = [];
      const mentions = finite(c.socialMentions);
      if (mentions != null && fit('socialMentions') >= EVIDENCE_FIT) {
        out.push(`${mentions.toFixed(0)} recent mention${mentions === 1 ? '' : 's'} in public news and forums`);
      }
      const ba = finite(c.m.buyerAcceleration);
      if (ba != null && fit('buyerAcceleration') >= EVIDENCE_FIT) out.push(`unique buyers arriving at ${times(ba)} the hourly pace`);
      const growth = finite(c.m.holdersGrowthPct);
      if (growth != null && fit('holdersGrowthPct') >= EVIDENCE_FIT) {
        const span = finite(c.m.holdersGrowthWindowMin);
        out.push(`holders up ${num(growth)}%${span != null ? ` in ${span.toFixed(0)} min` : ''}`);
      }
      if (c.s.boosted) out.push('a paid DexScreener boost');
      return out;
    },
  },

  'regime-filter': {
    lead: 'the conditions a market-regime trend filter looks for',
    features: [
      {
        feature: 'trendReference',
        label: 'Token change over 6h (1h when younger): above its earlier price?',
        weight: 2.5,
        value: trendReference,
        fit: (v) => ramp(v, 0, 20),
      },
      {
        feature: 'breadthPct',
        label: 'Market breadth (% of tracked tokens up over 1h)',
        weight: 2,
        required: true,
        value: (c) => regimeValue(c, c.regime.breadthPct),
        fit: (v, c) => ramp(v, 45, 70) * aboveTrend(c),
      },
      {
        feature: 'medianH1ChangePct',
        label: 'Median 1h change of tracked tokens',
        weight: 1.5,
        value: (c) => regimeValue(c, c.regime.medianH1ChangePct),
        fit: (v, c) => ramp(v, 0, 10) * aboveTrend(c),
      },
      {
        feature: 'relativeStrengthH1',
        label: '1h change minus market median (pct points)',
        weight: 1,
        value: (c) => {
          const h1 = pc(c, 'h1');
          const median = regimeValue(c, c.regime.medianH1ChangePct);
          return h1 != null && median != null ? h1 - median : null;
        },
        fit: (v) => ramp(v, 0, 20),
      },
    ],
    evidence: (c, fit) => {
      const out: string[] = [];
      const breadth = regimeValue(c, c.regime.breadthPct);
      const median = regimeValue(c, c.regime.medianH1ChangePct);
      if (breadth != null && median != null && (fit('breadthPct') >= EVIDENCE_FIT || fit('medianH1ChangePct') >= EVIDENCE_FIT)) {
        out.push(`a ${c.regime.label} market (${num(breadth)}% of tracked tokens up over 1h, median ${signedPct(median)})`);
      }
      const h6 = pc(c, 'h6');
      const ref = trendReference(c);
      if (ref != null && fit('trendReference') >= EVIDENCE_FIT) {
        out.push(`the token above its price ${h6 != null ? '6h' : '1h'} ago (${signedPct(ref)})`);
      }
      return out;
    },
  },

  'risk-overlay': {
    lead: 'what a drawdown and position-sizing overlay reacts to',
    tail: 'conditions in which sizing rules cut exposure to a minimum',
    features: [
      {
        feature: 'worstChange',
        label: 'Worst of 1h / 6h / 24h change, or since launch (drawdown proxy)',
        weight: 3,
        value: (c) => worstChange(c)?.pct ?? null,
        fit: (v) => ramp(v, -10, -50),
      },
      {
        feature: 'liquidityChangePct',
        label: 'Liquidity change across our snapshots (%)',
        weight: 2,
        value: (c) => finite(c.m.liquidityChangePct),
        fit: (v) => ramp(v, -5, -30),
      },
      {
        feature: 'sellPct',
        label: 'Sell share of transactions',
        weight: 1.5,
        value: (c) => finite(c.m.sellPct),
        fit: (v) => ramp(v, 55, 75),
      },
      {
        feature: 'top10HolderPct',
        label: 'Top-10 holder concentration (%)',
        weight: 1.5,
        value: (c) => finite(c.s.top10HolderPct),
        fit: (v) => ramp(v, 30, 70),
      },
      {
        feature: 'securityRedFlags',
        label: 'Security red flags (authorities, honeypot, dev stake)',
        weight: 1.5,
        value: securityRedFlags,
        fit: (v) => ramp(v, 0, 2),
      },
    ],
    evidence: (c, fit) => {
      const out: string[] = [];
      const worst = worstChange(c);
      if (worst && fit('worstChange') >= EVIDENCE_FIT) out.push(`${an(num(worst.pct))}% drop ${worst.span}`);
      const liq = finite(c.m.liquidityChangePct);
      if (liq != null && fit('liquidityChangePct') >= EVIDENCE_FIT) out.push(`liquidity down ${num(liq)}% in our recent snapshots`);
      const sell = finite(c.m.sellPct);
      if (sell != null && fit('sellPct') >= EVIDENCE_FIT) out.push(`${num(sell)}% of transactions being sells`);
      const top10 = finite(c.s.top10HolderPct);
      if (top10 != null && fit('top10HolderPct') >= EVIDENCE_FIT) out.push(`top-10 holders owning ${num(top10)}% of supply`);
      const flags = securityRedFlags(c);
      if (flags != null && flags > 0) out.push(`${flags} security red flag${flags === 1 ? '' : 's'}`);
      return out;
    },
  },
};

/** Methodology ids that have a matching signature (exposed for consistency checks). */
export const SIGNATURE_IDS: readonly string[] = Object.keys(SIGNATURES);

/* ─────────────────────────── scoring ─────────────────────────── */

function evaluate(sig: Signature, c: Ctx): { factors: QuantFactor[]; score: number; coverage: number } {
  let totalWeight = 0;
  let availableWeight = 0;
  let weightedFit = 0;
  let missingRequired = false;
  const factors = sig.features.map((f): QuantFactor => {
    totalWeight += f.weight;
    const value = finite(f.value(c));
    const fit = value == null ? 0 : clamp01(finite(f.fit(value, c)) ?? 0);
    if (value != null) {
      availableWeight += f.weight;
      weightedFit += f.weight * fit;
    } else if (f.required) {
      missingRequired = true;
    }
    return { feature: f.feature, label: f.label, value, fit: Math.round(fit * 1000) / 1000, weight: f.weight };
  });
  const coverage = totalWeight > 0 ? availableWeight / totalWeight : 0;
  if (availableWeight === 0 || missingRequired) return { factors, score: 0, coverage };
  const raw = 100 * (weightedFit / availableWeight) * Math.min(1, coverage / FULL_COVERAGE);
  return { factors, score: Math.max(0, Math.min(100, Math.round(raw))), coverage };
}

function rationale(sig: Signature, c: Ctx, factors: QuantFactor[], score: number, coverage: number): string {
  const fitOf = (feature: string): number => factors.find((f) => f.feature === feature)?.fit ?? 0;
  const verb = score >= STRONG_SCORE ? 'resemble' : score >= WEAK_SCORE ? 'partly resemble' : 'only weakly resemble';
  const clauses = sig.evidence(c, fitOf);
  if (!clauses.length) {
    const basis = coverage < 1 ? `, judged on ${Math.round(coverage * 100)}% of its inputs` : '';
    return `Current conditions ${verb} ${sig.lead}${basis}.`;
  }
  const tail = sig.tail ? ` — ${sig.tail}` : '';
  return `Current conditions ${verb} ${sig.lead}: ${clauses.join(', ')}${tail}.`;
}

/* ─────────────────────────── risk flags ─────────────────────────── */

function riskFlags(s: TokenSnapshot, m: DerivedMetrics): string[] {
  const flags: string[] = [];
  const sec = s.security;
  if (sec?.mintAuthority === true) flags.push('Mint authority enabled');
  if (sec?.freezeAuthority === true) flags.push('Freeze authority enabled');
  if (sec?.honeypot === 'yes') flags.push('Honeypot detected');
  else if (!sec || sec.honeypot === 'unknown') flags.push('Honeypot status unknown');
  const liq = finite(s.liquidityUsd);
  if (liq != null && liq < MIN_SAFE_LIQUIDITY_USD) flags.push('Liquidity under $10k');
  const top10 = finite(s.top10HolderPct);
  if (top10 != null && top10 > MAX_TOP10_PCT) flags.push(`Top-10 holders own ${num(top10)}% of supply`);
  // like an unknown honeypot status: unknown concentration never caps a severity, so the story says it is unknown
  else if (top10 == null) flags.push('Holder concentration unknown');
  const dev = finite(sec?.devHoldingPct);
  if (dev != null && dev > MAX_DEV_PCT) flags.push(`Developer holds ${num(dev)}% of supply`);
  const age = finite(m.ageMinutes);
  if (age != null && age < MIN_AGE_MINUTES) flags.push('Token younger than 15 minutes');
  const vtl = finite(m.volumeToLiquidity);
  if (vtl != null && vtl > MAX_VOLUME_TO_LIQUIDITY) flags.push(`Volume is ${times(vtl)} liquidity (wash-trading risk)`);
  if (s.boosted) flags.push('Boosted listing (paid promotion)');
  return flags;
}

/* ─────────────────────────── public API ─────────────────────────── */

/**
 * Scores how closely a token's current conditions resemble each methodology's
 * signature. Similarity only — never a forecast. Pure; missing data lowers
 * coverage instead of being guessed.
 */
export function matchQuant(
  s: TokenSnapshot,
  m: DerivedMetrics,
  regime: MarketRegime,
  o: { socialMentions?: number | null } = {},
): QuantResult {
  const c: Ctx = { s, m, regime, socialMentions: o.socialMentions ?? null };
  const matches: QuantMatch[] = [];
  for (const method of METHODOLOGIES) {
    const sig = SIGNATURES[method.id];
    if (!sig) continue;
    const { factors, score, coverage } = evaluate(sig, c);
    if (score <= 0) continue;
    matches.push({
      methodologyId: method.id,
      name: method.name,
      family: method.family,
      score,
      coverage: Math.round(coverage * 100) / 100,
      rationale: rationale(sig, c, factors, score, coverage),
      factors,
    });
  }
  // Array.prototype.sort is stable, so ties keep library order.
  matches.sort((a, b) => b.score - a.score);
  return {
    top: matches[0] ?? null,
    matches,
    regime,
    riskFlags: riskFlags(s, m),
    disclaimer: QUANT_DISCLAIMER,
  };
}
