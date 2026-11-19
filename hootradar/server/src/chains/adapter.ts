/*
 * Generic chain adapter on top of GeckoTerminal + DexScreener (+ chain
 * launchpads such as pump.fun). Discovery tolerates partial provider failure.
 */
import type { TokenSnapshot } from '../../../shared/types.js';
import { errMsg, logger, type Logger } from '../log.js';
import { dsLatestListings, dsTokens, type DsListing } from '../sources/dexscreener.js';
import type { CallOpts } from '../net/http.js';
import { gtNewPools, gtTokenInfo, gtTokenTopPool } from '../sources/geckoterminal.js';
import { emptySnapshot, mergeAcrossPools, mergeSnapshots } from '../sources/merge.js';
import { pumpNewest } from '../sources/pumpfun.js';
import type { ChainAdapter, ChainConfig, TokenEnrichment } from './types.js';

export interface AdapterOptions {
  /** discovered tokens older than this are dropped when their age is known (default 24) */
  maxTokenAgeHours?: number;
}

const DEFAULT_MAX_TOKEN_AGE_HOURS = 24;
const PUMPFUN_DISCOVERY_LIMIT = 40;
/** discovered tokens that get a DexScreener market-data refresh per cycle (2 batch calls) */
const DISCOVERY_REFRESH_LIMIT = 60;

/**
 * Each discovery source must answer within this long (queueing for its provider's
 * limiter included). A provider that is paused or slow is abandoned for this cycle
 * instead of holding back the sources that already answered.
 */
const DISCOVERY_SOURCE_DEADLINE_MS = 12_000;
/** GeckoTerminal paused after a 429 for longer than this: skip it this cycle (polled again in 55 s) */
const GT_DISCOVERY_MAX_PAUSE_WAIT_MS = 5_000;

interface DiscoverySource {
  name: string;
  /** a source whose data refreshes slower than the discovery cadence is polled at most this often */
  minIntervalMs?: number;
  fetch(config: ChainConfig, now: number, signal: AbortSignal): Promise<TokenSnapshot[]>;
}

/**
 * GeckoTerminal serves `new_pools` from its CDN for 60 s (s-maxage=60), and its
 * free tier allows ~30 requests a minute per client across every chain. Polling
 * faster only spends that budget (and earns 429s) on identical responses.
 */
const GT_NEW_POOLS_INTERVAL_MS = 55_000;

const geckoNewPools: DiscoverySource = {
  name: 'geckoterminal',
  minIntervalMs: GT_NEW_POOLS_INTERVAL_MS,
  fetch: (config, _now, signal) =>
    gtNewPools(config.geckoNetwork, config.id, {
      signal,
      maxQueueMs: DISCOVERY_SOURCE_DEADLINE_MS,
      maxPauseWaitMs: GT_DISCOVERY_MAX_PAUSE_WAIT_MS,
    }),
};

const dexscreenerListings: DiscoverySource = {
  name: 'dexscreener-listings',
  fetch: async (config, now, signal) =>
    (await dsLatestListings({ signal, maxQueueMs: DISCOVERY_SOURCE_DEADLINE_MS }))
      .filter((l) => l.dsChainId === config.dexscreenerChainId)
      .map((l) => listingSnapshot(config, l, now)),
};

const pumpfunNewest: DiscoverySource = {
  name: 'pumpfun',
  fetch: (_config, _now, signal) => pumpNewest(PUMPFUN_DISCOVERY_LIMIT, { signal, maxQueueMs: DISCOVERY_SOURCE_DEADLINE_MS }),
};

/** Chain-specific launchpads, on top of the generic discovery sources. */
const LAUNCHPADS: Partial<Record<string, DiscoverySource[]>> = {
  solana: [pumpfunNewest],
};

/** A listing only identifies the token; the DexScreener refresh supplies its market data. */
function listingSnapshot(config: ChainConfig, l: DsListing, now: number): TokenSnapshot {
  return {
    ...emptySnapshot(config.id, l.address, now),
    imageUrl: l.imageUrl,
    links: l.links,
    boosted: l.boosted,
    sources: ['dexscreener'],
  };
}

class GenericChainAdapter implements ChainAdapter {
  private readonly log: Logger;
  /** order sets refresh priority when more tokens are discovered than get refreshed */
  private readonly sources: DiscoverySource[];
  private readonly maxAgeMs: number;
  /** when each throttled discovery source was last attempted */
  private readonly lastPolled = new Map<string, number>();

  constructor(
    readonly config: ChainConfig,
    opts: AdapterOptions,
  ) {
    this.log = logger(`chain:${config.id}`);
    this.sources = [geckoNewPools, dexscreenerListings, ...(LAUNCHPADS[config.id] ?? [])];
    this.maxAgeMs = (opts.maxTokenAgeHours ?? DEFAULT_MAX_TOKEN_AGE_HOURS) * 3_600_000;
  }

  isAddress(query: string): boolean {
    return this.config.addressPattern.test(query.trim());
  }

  normalizeAddress(address: string): string {
    const a = address.trim();
    return this.config.caseInsensitiveAddress ? a.toLowerCase() : a;
  }

  async discover(): Promise<TokenSnapshot[]> {
    const now = Date.now();
    const found = await this.collect(now);
    await this.fillMarketData(found);
    return this.youngestFirst([...found.values()], now);
  }

  refresh(addresses: string[], o: CallOpts = {}): Promise<TokenSnapshot[]> {
    if (addresses.length === 0) return Promise.resolve([]);
    return dsTokens(this.config.dexscreenerChainId, this.config.id, addresses, o);
  }

  /**
   * GeckoTerminal token info plus the unique-wallet counts of the token's main
   * pool (both cached by the source module). Null when GeckoTerminal does not know
   * the token; throws when token info failed. A failed pool lookup only drops the wallets.
   */
  async enrich(address: string, o: CallOpts = {}): Promise<TokenEnrichment | null> {
    const addr = address.trim();
    const { geckoNetwork, id } = this.config;
    const [info, pool] = await Promise.allSettled([gtTokenInfo(geckoNetwork, addr, o), gtTokenTopPool(geckoNetwork, id, addr, o)]);
    if (info.status === 'rejected') throw info.reason;
    if (!info.value) return null;
    if (pool.status === 'rejected') this.log.debug('enrich pool lookup failed', { address: addr, error: errMsg(pool.reason) });
    const top = pool.status === 'fulfilled' ? pool.value : null;
    return top
      ? { ...info.value, wallets: { pairAddress: top.pairAddress, txns: top.txns }, poolCreatedAt: top.createdAt }
      : info.value;
  }

  /**
   * The token's main pool from DexScreener and GeckoTerminal, plus GeckoTerminal
   * token info (holders, security). When both providers describe the same pool,
   * DexScreener's figures overlay GeckoTerminal's (which add unique buyers/sellers
   * and m15/m30). When they picked different pools — DexScreener's token endpoint
   * returns a single pair, not always the deepest — the more liquid pool is used
   * and the other contributes only token-level facts, never its per-pool windows.
   * Null when neither market source knows the token; throws only if every source failed.
   */
  async lookup(address: string, o: CallOpts = {}): Promise<TokenSnapshot | null> {
    const addr = address.trim();
    if (!this.isAddress(addr)) return null;
    const { geckoNetwork, dexscreenerChainId, id } = this.config;
    const [ds, pool, info] = await Promise.allSettled([
      dsTokens(dexscreenerChainId, id, [addr], o),
      gtTokenTopPool(geckoNetwork, id, addr, o),
      gtTokenInfo(geckoNetwork, addr, o),
    ]);
    const failed = [ds, pool, info].filter((r) => r.status === 'rejected').map((r) => errMsg(r.reason));
    if (failed.length === 3) throw new Error(`lookup failed: ${failed.join('; ')}`);
    if (failed.length > 0) this.log.warn('lookup partially failed', { address: addr, errors: failed });

    const key = this.normalizeAddress(addr);
    const dsSnap = ds.status === 'fulfilled' ? (ds.value.find((s) => this.normalizeAddress(s.address) === key) ?? null) : null;
    const gtSnap = pool.status === 'fulfilled' ? pool.value : null;
    const market = gtSnap && dsSnap ? mergeAcrossPools(gtSnap, dsSnap, 'deeper') : (dsSnap ?? gtSnap);
    if (!market) return null;
    return info.status === 'fulfilled' && info.value ? mergeSnapshots(market, info.value) : market;
  }

  /**
   * Run every discovery source that is due, each within its own deadline; merge by
   * normalized address in source order.
   */
  private async collect(now: number): Promise<Map<string, TokenSnapshot>> {
    const due = this.sources.filter((s) => this.isDue(s, now));
    const results = await Promise.allSettled(
      due.map((s) => withDeadline((signal) => s.fetch(this.config, now, signal), DISCOVERY_SOURCE_DEADLINE_MS, s.name)),
    );
    const found = new Map<string, TokenSnapshot>();
    const errors: string[] = [];
    results.forEach((result, i) => {
      const name = due[i]?.name ?? `source ${i}`;
      if (result.status === 'rejected') {
        errors.push(`${name}: ${errMsg(result.reason)}`);
        return;
      }
      for (const snap of result.value) this.add(found, snap);
    });
    if (due.length > 0 && errors.length === due.length) {
      throw new Error(`all discovery sources failed (${errors.join('; ')})`);
    }
    if (errors.length > 0) this.log.warn('discovery source failed', { errors });
    return found;
  }

  /** Throttled sources count an attempt whether or not it succeeds, so a failing provider is not hammered. */
  private isDue(source: DiscoverySource, now: number): boolean {
    if (!source.minIntervalMs) return true;
    const last = this.lastPolled.get(source.name);
    if (last !== undefined && now - last < source.minIntervalMs) return false;
    this.lastPolled.set(source.name, now);
    return true;
  }

  /** Two sources may report different pools of one token: the deeper pool is kept whole. */
  private add(found: Map<string, TokenSnapshot>, snap: TokenSnapshot): void {
    const key = this.normalizeAddress(snap.address);
    const prev = found.get(key);
    found.set(key, prev ? mergeAcrossPools(prev, snap, 'deeper') : snap);
  }

  /**
   * DexScreener refresh of the first discovered tokens; on failure they keep their
   * discovery data. The refresh describes the token's main pool, which is not always
   * the new pool discovery found: its pool then replaces the discovered one whole
   * (the scanner's refreshes read the same pool, so the token's history stays one series).
   */
  private async fillMarketData(found: Map<string, TokenSnapshot>): Promise<void> {
    const targets = [...found.values()].slice(0, DISCOVERY_REFRESH_LIMIT).map((s) => s.address);
    if (targets.length === 0) return;
    try {
      const fresh = await this.refresh(targets);
      for (const snap of fresh) {
        const key = this.normalizeAddress(snap.address);
        const prev = found.get(key);
        if (prev) found.set(key, mergeAcrossPools(prev, snap, 'extra'));
      }
    } catch (e) {
      this.log.warn('discovery refresh failed', { error: errMsg(e), tokens: targets.length });
    }
  }

  /** Drop unidentified (no symbol) and too-old tokens; newest first, unknown age last. */
  private youngestFirst(snaps: TokenSnapshot[], now: number): TokenSnapshot[] {
    return snaps
      .filter((s) => s.symbol !== '')
      .filter((s) => s.createdAt === null || now - s.createdAt <= this.maxAgeMs)
      .sort(newestFirst);
  }
}

/** Runs `work` with an abort signal that fires after `ms`; rejects at the deadline even if `work` ignores the signal. */
async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function newestFirst(a: TokenSnapshot, b: TokenSnapshot): number {
  if (a.createdAt === b.createdAt) return 0;
  if (a.createdAt === null) return 1;
  if (b.createdAt === null) return -1;
  return b.createdAt - a.createdAt;
}

export function createAdapter(config: ChainConfig, opts: AdapterOptions = {}): ChainAdapter {
  return new GenericChainAdapter(config, opts);
}
