import type { EngineState, Stats } from '../../../shared/types.js';
import type { Db } from '../db/db.js';
import type { DistributionQueue } from '../distribution/queue.js';
import type { Scanner } from './scanner.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StatsDeps {
  db: Db;
  scanner: Scanner;
  engine: EngineState;
  distribution: DistributionQueue;
  startedAt: number;
  now: number;
}

/** Header numbers. Everything comes from the database or live scanner state. */
export function buildStats(d: StatsDeps): Stats {
  const since = d.now - DAY_MS;
  const counts = d.db.counts(since);
  const chains = d.scanner.chainInfo();
  const lastScanAt = d.scanner.lastScanAt();
  const chainsScanning = chains.filter((c) => c.status === 'scanning').length;
  return {
    engine: { ...d.engine, status: engineStatus(d.engine, lastScanAt, chainsScanning) },
    chainsScanning,
    chainsTotal: chains.length,
    tokensAnalyzed24h: counts.tokensAnalyzed,
    anomalies24h: counts.anomalies,
    breaking24h: counts.breaking,
    articles24h: counts.articles,
    lastScanAt,
    startedAt: d.startedAt,
    chains,
    distribution: { channels: d.distribution.enabledChannels(), sent24h: d.distribution.sentSince(since) },
  };
}

/**
 * The AI layer reports its own health; the platform is additionally `starting`
 * until the first successful scan and `degraded` while no chain is scanning.
 */
function engineStatus(engine: EngineState, lastScanAt: number | null, chainsScanning: number): EngineState['status'] {
  if (lastScanAt == null) return 'starting';
  if (engine.status === 'degraded' || chainsScanning === 0) return 'degraded';
  return 'active';
}
