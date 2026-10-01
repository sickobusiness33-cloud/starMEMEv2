import type { DerivedMetrics, MarketRegime, QuantLeader, QuantMatch, TokenSnapshot } from '../../../shared/types.js';
import { errMsg, logger } from '../log.js';
import { METHODOLOGIES } from './library.js';
import { matchQuant } from './matcher.js';

const log = logger('quant');

/** Below this similarity a token is not presented as a leader of a methodology. */
export const MIN_LEADER_SCORE = 40;

export interface LeaderEntry {
  snapshot: TokenSnapshot;
  metrics: DerivedMetrics;
  articleId: string | null;
}

type LeaderToken = QuantLeader['tokens'][number];

/**
 * For every methodology in the library, the `topN` tokens that currently
 * resemble it most (score ≥ MIN_LEADER_SCORE), best first. Methodologies with no
 * qualifying token are still listed with an empty `tokens` array.
 */
export function computeLeaders(entries: LeaderEntry[], regime: MarketRegime, topN = 3): QuantLeader[] {
  const limit = Math.max(0, Math.floor(topN));
  const byMethod = new Map<string, LeaderToken[]>(METHODOLOGIES.map((m) => [m.id, []]));

  for (const entry of newestPerToken(entries)) {
    for (const match of safeMatches(entry, regime)) {
      if (match.score < MIN_LEADER_SCORE) continue;
      byMethod.get(match.methodologyId)?.push(toLeaderToken(entry, match.score));
    }
  }

  return METHODOLOGIES.map((m) => ({
    methodologyId: m.id,
    tokens: (byMethod.get(m.id) ?? []).sort(compareLeaders).slice(0, limit),
  }));
}

/** One malformed entry must not take the whole leaderboard down. */
function safeMatches(entry: LeaderEntry, regime: MarketRegime): QuantMatch[] {
  try {
    return matchQuant(entry.snapshot, entry.metrics, regime).matches;
  } catch (e) {
    const { chain, address } = entry.snapshot;
    log.warn('quant match failed for leader entry', { chain, address, error: errMsg(e) });
    return [];
  }
}

function toLeaderToken(entry: LeaderEntry, score: number): LeaderToken {
  const s = entry.snapshot;
  return {
    chain: s.chain,
    address: s.address,
    symbol: s.symbol,
    name: s.name,
    liquidityUsd: s.liquidityUsd,
    marketCapUsd: s.marketCapUsd,
    createdAt: s.createdAt,
    imageUrl: s.imageUrl,
    score,
    articleId: entry.articleId,
  };
}

/** Higher score first; deeper liquidity breaks ties (unknown liquidity last), then symbol for determinism. */
function compareLeaders(a: LeaderToken, b: LeaderToken): number {
  return b.score - a.score || (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1) || a.symbol.localeCompare(b.symbol);
}

/** A token can appear several times in the input; keep its newest observation only. */
function newestPerToken(entries: LeaderEntry[]): LeaderEntry[] {
  const newest = new Map<string, LeaderEntry>();
  for (const e of entries) {
    const { chain, address } = e.snapshot;
    const key = `${chain}:${address.startsWith('0x') ? address.toLowerCase() : address}`;
    const seen = newest.get(key);
    if (!seen || e.snapshot.ts > seen.snapshot.ts) newest.set(key, e);
  }
  return [...newest.values()];
}
