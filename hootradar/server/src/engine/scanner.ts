import type { ChainInfo, ChainStatus, TokenSnapshot } from '../../../shared/types.js';
import type { ChainAdapter } from '../chains/types.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/db.js';
import { errMsg, logger } from '../log.js';
import type { Bus } from './bus.js';
import type { Pipeline } from './pipeline.js';

const log = logger('scanner');

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SCANNING_WINDOW_MS = 2 * MINUTE_MS;
const DEGRADED_WINDOW_MS = 10 * MINUTE_MS;
/**
 * Young tokens refreshed per chain and cycle (DexScreener batches of 30). Active
 * tokens are refreshed first, so busy launchpad chains keep every tradeable token.
 */
const TRACKED_PER_CHAIN = 240;
/** snapshots stored and assessed between two yields to the event loop (HTTP stays responsive) */
const INGEST_SLICE = 25;
const COUNTS_TTL_MS = 30_000;
const FIRST_PRUNE_DELAY_MS = MINUTE_MS;
const PRUNE_INTERVAL_MS = 60 * MINUTE_MS;
const MIN_TICK_DELAY_MS = 100;

type CycleKind = 'discover' | 'refresh';

interface ChainState {
  adapter: ChainAdapter;
  nextDiscoverAt: number;
  nextRefreshAt: number;
  lastSuccessAt: number | null;
  /** latest attempt of each kind; `error` is null when it succeeded */
  lastAttempt: Partial<Record<CycleKind, { at: number; error: string | null }>>;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
}

export interface ScannerDeps {
  adapters: ChainAdapter[];
  db: Db;
  bus: Bus;
  pipeline: Pipeline;
  config: AppConfig;
}

/**
 * Drives every chain: `discover()` every discoverIntervalMs (chains staggered so
 * providers see an even load) and `refresh()` of tracked young tokens every
 * refreshIntervalMs. Each chain runs one setTimeout chain, so its cycles never
 * overlap. Every snapshot is stored and handed to the pipeline.
 */
export class Scanner {
  private readonly chains: ChainState[];
  private active = false;
  private pruneTimer: NodeJS.Timeout | null = null;
  private tokenCounts: { at: number; perChain: Record<string, number> } | null = null;

  constructor(private readonly d: ScannerDeps) {
    this.chains = d.adapters.map((adapter) => ({
      adapter,
      nextDiscoverAt: 0,
      nextRefreshAt: 0,
      lastSuccessAt: null,
      lastAttempt: {},
      timer: null,
      running: null,
    }));
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const { discoverIntervalMs, refreshIntervalMs } = this.d.config.scan;
    const stagger = discoverIntervalMs / Math.max(1, this.chains.length);
    const t0 = Date.now();
    this.chains.forEach((c, i) => {
      c.nextDiscoverAt = t0 + Math.round(stagger * i);
      c.nextRefreshAt = c.nextDiscoverAt + Math.round(Math.min(stagger, refreshIntervalMs) / 2);
      this.schedule(c, c.nextDiscoverAt - t0);
    });
    this.schedulePrune(FIRST_PRUNE_DELAY_MS);
    log.info('scanner started', {
      chains: this.chains.map((c) => c.adapter.config.id),
      discoverIntervalMs,
      refreshIntervalMs,
    });
  }

  /**
   * Stops scheduling and waits for the cycles already running (their remaining
   * snapshots are skipped). Background article work is the pipeline's to stop.
   */
  async stop(): Promise<void> {
    this.active = false;
    for (const c of this.chains) {
      if (c.timer) clearTimeout(c.timer);
      c.timer = null;
    }
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = null;
    await Promise.allSettled(this.chains.map((c) => c.running ?? Promise.resolve()));
  }

  chainInfo(): ChainInfo[] {
    const now = Date.now();
    const perChain = this.perChainTokens(now);
    return this.chains.map((c) => {
      const cfg = c.adapter.config;
      return {
        id: cfg.id,
        name: cfg.name,
        short: cfg.short,
        nativeSymbol: cfg.nativeSymbol,
        color: cfg.color,
        status: chainStatus(c, now),
        lastScanAt: c.lastSuccessAt,
        lastError: lastError(c),
        tokensSeen24h: perChain[cfg.id] ?? 0,
      };
    });
  }

  /** Most recent successful scan across all chains. */
  lastScanAt(): number | null {
    let latest: number | null = null;
    for (const c of this.chains) {
      if (c.lastSuccessAt != null && (latest == null || c.lastSuccessAt > latest)) latest = c.lastSuccessAt;
    }
    return latest;
  }

  /* ───────────── scheduling ───────────── */

  private schedule(c: ChainState, delayMs: number): void {
    if (!this.active) return;
    c.timer = setTimeout(() => {
      c.timer = null;
      c.running = this.tick(c)
        .catch((e: unknown) => log.error('tick failed', { chain: c.adapter.config.id, error: errMsg(e) }))
        .finally(() => {
          c.running = null;
          this.schedule(c, Math.max(MIN_TICK_DELAY_MS, Math.min(c.nextDiscoverAt, c.nextRefreshAt) - Date.now()));
        });
    }, Math.max(0, delayMs));
    c.timer.unref();
  }

  private async tick(c: ChainState): Promise<void> {
    const { discoverIntervalMs, refreshIntervalMs } = this.d.config.scan;
    if (Date.now() >= c.nextDiscoverAt) {
      c.nextDiscoverAt = Date.now() + discoverIntervalMs;
      await this.cycle(c, 'discover');
    }
    if (this.active && Date.now() >= c.nextRefreshAt) {
      c.nextRefreshAt = Date.now() + refreshIntervalMs;
      await this.cycle(c, 'refresh');
    }
  }

  private schedulePrune(delayMs: number): void {
    if (!this.active) return;
    this.pruneTimer = setTimeout(() => {
      this.prune();
      this.schedulePrune(PRUNE_INTERVAL_MS);
    }, delayMs);
    this.pruneTimer.unref();
  }

  private prune(): void {
    const started = Date.now();
    try {
      this.d.db.prune(started);
      log.debug('database pruned', { ms: Date.now() - started });
    } catch (e) {
      log.warn('prune failed', { error: errMsg(e) });
    }
  }

  /* ───────────── cycles ───────────── */

  private async cycle(c: ChainState, kind: CycleKind): Promise<void> {
    const chain = c.adapter.config.id;
    const started = Date.now();
    let snapshots: TokenSnapshot[] | null;
    try {
      snapshots = await this.fetch(c, kind);
    } catch (e) {
      const error = errMsg(e);
      const at = Date.now();
      c.lastAttempt[kind] = { at, error };
      log.warn(`${kind} failed`, { chain, error });
      this.d.bus.emit('scan', { chain, kind, ok: false, tokens: 0, error, at });
      return;
    }
    if (snapshots === null) return; // nothing to refresh yet

    const fetchedAt = Date.now();
    const firstSuccess = c.lastSuccessAt == null;
    c.lastSuccessAt = fetchedAt;
    c.lastAttempt[kind] = { at: fetchedAt, error: null };
    await this.ingest(snapshots);
    if (firstSuccess) this.tokenCounts = null; // do not keep serving counts cached before this chain's first data
    log.debug(`${kind} done`, { chain, tokens: snapshots.length, ms: Date.now() - started });
    this.d.bus.emit('scan', { chain, kind, ok: true, tokens: snapshots.length, error: null, at: Date.now() });
  }

  /** null = nothing to do (no tracked tokens to refresh). */
  private async fetch(c: ChainState, kind: CycleKind): Promise<TokenSnapshot[] | null> {
    if (kind === 'discover') return c.adapter.discover();
    const { maxTokenAgeHours, minLiquidityUsd, minVolumeH1Usd } = this.d.config.scan;
    const addresses = this.d.db.trackedAddresses(c.adapter.config.id, maxTokenAgeHours, TRACKED_PER_CHAIN, Date.now(), {
      minLiquidityUsd,
      minVolumeH1Usd,
    });
    return addresses.length ? c.adapter.refresh(addresses) : null;
  }

  /**
   * Stores every snapshot and hands it to the pipeline, which decides synchronously
   * and moves anything that needs the network (mentions, enrichment, the article)
   * to its background workers: a cycle never waits for an article to be written.
   */
  private async ingest(snapshots: TokenSnapshot[]): Promise<void> {
    for (let i = 0; i < snapshots.length; i++) {
      if (!this.active) return;
      if (i > 0 && i % INGEST_SLICE === 0) await yieldToEventLoop();
      const s = snapshots[i] as TokenSnapshot;
      try {
        this.d.db.insertSnapshot(s); // also upserts the token row
      } catch (e) {
        log.error('storing snapshot failed', { chain: s.chain, address: s.address, error: errMsg(e) });
        continue;
      }
      this.d.pipeline.process(s, Date.now());
    }
  }

  private perChainTokens(now: number): Record<string, number> {
    if (this.tokenCounts && now - this.tokenCounts.at < COUNTS_TTL_MS) return this.tokenCounts.perChain;
    let perChain = this.tokenCounts?.perChain ?? {};
    try {
      perChain = this.d.db.counts(now - DAY_MS).perChainTokens;
    } catch (e) {
      log.warn('token counts unavailable', { error: errMsg(e) });
    }
    this.tokenCounts = { at: now, perChain };
    return perChain;
  }
}

/**
 * scanning: a scan succeeded within 2 min · degraded: the latest attempt failed but
 * a scan succeeded within 10 min · down: otherwise · idle: nothing attempted yet.
 */
function chainStatus(c: ChainState, now: number): ChainStatus {
  const attempts = Object.values(c.lastAttempt);
  if (!attempts.length) return 'idle';
  const sinceSuccess = c.lastSuccessAt != null ? now - c.lastSuccessAt : Infinity;
  if (sinceSuccess < SCANNING_WINDOW_MS) return 'scanning';
  const latest = attempts.reduce((a, b) => (b.at > a.at ? b : a));
  if (latest.error != null && sinceSuccess < DEGRADED_WINDOW_MS) return 'degraded';
  return 'down';
}

/** Most recent error among the cycle kinds whose latest attempt failed. */
function lastError(c: ChainState): string | null {
  let latest: { at: number; error: string | null } | null = null;
  for (const a of Object.values(c.lastAttempt)) {
    if (a.error != null && (!latest || a.at > latest.at)) latest = a;
  }
  return latest?.error ?? null;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
