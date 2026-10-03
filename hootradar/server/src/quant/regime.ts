import type { MarketRegime, TokenSnapshot } from '../../../shared/types.js';

/** Below this many eligible tokens breadth and median are noise, so the regime is 'unknown'. */
export const MIN_REGIME_SAMPLE = 12;
/** Pools thinner than this are excluded: their 1h change is mostly single-trade noise. */
export const MIN_REGIME_LIQUIDITY_USD = 5000;
/** An observation older than this no longer describes the last hour. */
export const MAX_OBSERVATION_AGE_MS = 60 * 60_000;
/**
 * A token younger than this reports its whole life as its "1h" change (launch pumps from a
 * near-zero price), which would swamp breadth and the median. Tokens of unknown age are kept.
 */
export const MIN_REGIME_TOKEN_AGE_MS = 45 * 60_000;

const RISK_ON_BREADTH = 55;
const RISK_OFF_BREADTH = 40;

/**
 * Market regime of the tracked young-token universe: breadth (% with a positive
 * 1h change) and median 1h change over liquid, recently observed tokens that are
 * old enough for their 1h change to be a real one-hour change.
 */
export function computeRegime(latest: TokenSnapshot[], now: number): MarketRegime {
  const changes = eligibleH1Changes(latest, now);
  const sampleSize = changes.length;
  if (sampleSize < MIN_REGIME_SAMPLE) {
    return { label: 'unknown', breadthPct: null, medianH1ChangePct: null, sampleSize, computedAt: now };
  }
  const breadthPct = (changes.filter((c) => c > 0).length / sampleSize) * 100;
  const medianH1ChangePct = median(changes);
  return { label: classify(breadthPct, medianH1ChangePct), breadthPct, medianH1ChangePct, sampleSize, computedAt: now };
}

function classify(breadthPct: number, medianPct: number): MarketRegime['label'] {
  if (breadthPct >= RISK_ON_BREADTH && medianPct > 0) return 'risk-on';
  if (breadthPct <= RISK_OFF_BREADTH && medianPct < 0) return 'risk-off';
  return 'neutral';
}

/** One h1 change per token (newest observation wins), from eligible tokens. */
function eligibleH1Changes(latest: TokenSnapshot[], now: number): number[] {
  const newest = new Map<string, TokenSnapshot>();
  for (const s of latest) {
    const key = `${s.chain}:${s.address.startsWith('0x') ? s.address.toLowerCase() : s.address}`;
    const seen = newest.get(key);
    if (!seen || s.ts > seen.ts) newest.set(key, s);
  }
  const changes: number[] = [];
  for (const s of newest.values()) {
    const h1 = s.priceChangePct.h1;
    if (h1 == null || !Number.isFinite(h1)) continue;
    if (s.liquidityUsd == null || !(s.liquidityUsd >= MIN_REGIME_LIQUIDITY_USD)) continue;
    if (now - s.ts > MAX_OBSERVATION_AGE_MS) continue;
    if (s.createdAt != null && now - s.createdAt < MIN_REGIME_TOKEN_AGE_MS) continue;
    changes.push(h1);
  }
  return changes;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 ? hi : ((sorted[mid - 1] ?? hi) + hi) / 2;
}

/** What the shared regime provider reads: the eligible universe, pre-filtered by storage. */
export type RegimeUniverseLoader = (
  now: number,
  filters: { maxObservationAgeMs: number; minLiquidityUsd: number; minTokenAgeMs: number; maxTokenAgeMs: number },
) => TokenSnapshot[];

/**
 * The one market regime the whole newsroom cites (articles, Radar and the
 * INTELLIGENCE tab), recomputed at most every `ttlMs` over every eligible token:
 * liquid, observed within the hour, between 45 minutes and `maxTokenAgeHours` old.
 * Never throws: a failed computation reads 'unknown'.
 */
export function createRegimeProvider(
  load: RegimeUniverseLoader,
  o: { maxTokenAgeHours: number; ttlMs?: number; onError?: (e: unknown) => void },
): () => MarketRegime {
  const ttl = o.ttlMs ?? 30_000;
  let current: MarketRegime | null = null;
  return () => {
    const now = Date.now();
    if (current && now - current.computedAt < ttl) return current;
    try {
      const universe = load(now, {
        maxObservationAgeMs: MAX_OBSERVATION_AGE_MS,
        minLiquidityUsd: MIN_REGIME_LIQUIDITY_USD,
        minTokenAgeMs: MIN_REGIME_TOKEN_AGE_MS,
        maxTokenAgeMs: o.maxTokenAgeHours * 60 * 60_000,
      });
      current = computeRegime(universe, now);
    } catch (e) {
      o.onError?.(e);
      current = { label: 'unknown', breadthPct: null, medianH1ChangePct: null, sampleSize: 0, computedAt: now };
    }
    return current;
  };
}
