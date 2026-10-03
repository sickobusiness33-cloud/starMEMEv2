/*
 * RADAR: on-demand investigation of one token. A report moves through six
 * stages (resolve → on-chain → holders → quant → web intel → AI brief); every
 * change is persisted (throttled) and pushed to subscribers as a full copy.
 * A failing stage is marked 'error' and the investigation continues where it can.
 *
 * Radar is public and interactive, so it must never starve the newsroom or run up
 * an unbounded bill: its provider calls use their own lane of each provider's
 * budget (fail fast instead of queueing), every stage has a deadline that cancels
 * its work, at most a few investigations run at once, and paid Claude calls draw
 * from an hourly budget and a per-visitor quota (results are reused per token).
 */
import { randomUUID } from 'node:crypto';
import type {
  ChainId,
  DerivedMetrics,
  MarketRegime,
  RadarBrief,
  RadarReport,
  RadarStage,
  RadarStageId,
  TokenRef,
  TokenSnapshot,
  UnavailableField,
} from '../../../shared/types.js';
import { writeRadarBrief } from '../ai/brief.js';
import { CallBudget, claudeSession } from '../ai/claude.js';
import { fmtUsd } from '../ai/format.js';
import { hasCachedResearch, webResearchEnabled } from '../ai/web-research.js';
import type { ChainAdapter } from '../chains/types.js';
import type { AppConfig } from '../config.js';
import { tokenKey, type Db } from '../db/db.js';
import { detectAnomalies } from '../engine/anomaly.js';
import type { LaunchBaselines } from '../engine/baselines.js';
import { deriveMetrics } from '../engine/metrics.js';
import { detectOptions } from '../engine/pipeline.js';
import { errMsg, logger } from '../log.js';
import type { CallOpts } from '../net/http.js';
import { matchQuant } from '../quant/matcher.js';
import { dsSearch } from '../sources/dexscreener.js';
import { mergeSnapshots } from '../sources/merge.js';
import { gatherIntel, intelQueryFor, type GatherOpts } from './intel/index.js';

const log = logger('radar');

export const RADAR_STAGES: ReadonlyArray<{ id: RadarStageId; label: string }> = [
  { id: 'resolve', label: 'Resolve' },
  { id: 'onchain', label: 'On-chain' },
  { id: 'holders', label: 'Holders' },
  { id: 'quant', label: 'Quant' },
  { id: 'web', label: 'Web intel' },
  { id: 'ai', label: 'AI brief' },
];

export const MAX_QUERY_CHARS = 120;
export const SMART_MONEY_REASON =
  'Labelled smart-money wallets require a dedicated on-chain analytics provider (e.g. Nansen/Arkham); HootRadar shows a large-wallet flow proxy instead.';

const MINUTE_MS = 60_000;
const HISTORY_MS = 90 * MINUTE_MS;
const SAVE_INTERVAL_MS = 300;
/** a repeated submit of the same query within this window joins the existing report (unless it failed) */
const DEDUPE_WINDOW_MS = 20_000;
const MEMORY_REPORTS = 50;
const MAX_CANDIDATES = 6;
/** investigations running at once across all visitors; beyond this a new one is refused (RadarBusyError) */
export const MAX_ACTIVE_INVESTIGATIONS = 4;
/**
 * Each stage's work is cancelled at its deadline (queued provider requests leave
 * their limiter, Claude calls are aborted). The web stage's providers have their
 * own, shorter budgets.
 */
const STAGE_DEADLINE_MS: Record<RadarStageId, number> = {
  resolve: 20_000,
  onchain: 20_000,
  holders: 20_000,
  quant: 10_000,
  web: 75_000,
  ai: 100_000,
};
/**
 * Radar's provider requests: the interactive lane of each provider's budget, never
 * waiting long for a slot (a busy lane answers "busy" instead of queueing behind
 * other visitors), and never waiting out a provider's 429 pause.
 */
const PROVIDER_CALL: Omit<CallOpts, 'signal'> = { lane: 'radar', maxQueueMs: 10_000, maxPauseWaitMs: 3_000 };
/** AI-backed investigations one visitor may start per window; beyond it Radar uses its free providers and the rules brief */
const CLIENT_AI_INVESTIGATIONS = 4;
const CLIENT_AI_WINDOW_MS = 10 * MINUTE_MS;
const CLIENT_LIMIT_ENTRIES = 5_000;
/** a Claude brief of a token is reused this long for repeated or rotated queries */
const BRIEF_TTL_MS = 10 * MINUTE_MS;
const BRIEF_CACHE_LIMIT = 200;

export interface RadarDeps {
  adapters: ChainAdapter[];
  db: Db;
  config: AppConfig;
  regime: () => MarketRegime;
  /** per-chain launch-traction baselines (the pipeline's), so Radar scores like the scanner */
  baselines?: LaunchBaselines;
  /** test seam; defaults to Date.now */
  now?: () => number;
}

export interface StartOpts {
  /** who asked (e.g. the client IP bucket): the per-visitor AI quota keys on it */
  client?: string;
}

/** Too many investigations are running; the caller should retry shortly. */
export class RadarBusyError extends Error {
  override name = 'RadarBusyError';
  constructor(readonly retryAfterSec: number) {
    super('Radar is busy with other investigations, retry shortly');
  }
}

type HolderLookup = { state: 'pending' } | { state: 'ok' } | { state: 'missing' } | { state: 'failed'; error: string };

/** Mutable working state of one running investigation. */
interface Investigation {
  report: RadarReport;
  client: string | null;
  /** this investigation already counted against its visitor's AI quota */
  aiCounted: boolean;
  adapter: ChainAdapter | null;
  /** resolved through DexScreener search: the on-chain stage still needs a full lookup */
  needsLookup: boolean;
  history: TokenSnapshot[];
  holders: HolderLookup;
  savedAt: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
}

interface StageOutcome {
  status: 'done' | 'skipped';
  message: string | null;
}

class NotFoundError extends Error {}

interface Resolved {
  adapter: ChainAdapter;
  snapshot: TokenSnapshot;
}

export class RadarService {
  /** finished reports, least recently used first */
  private readonly reports = new Map<string, RadarReport>();
  private readonly active = new Map<string, Investigation>();
  private readonly listeners = new Map<string, Set<(r: RadarReport) => void>>();
  private readonly recent = new Map<string, { id: string; at: number }>();
  private readonly clock: () => number;
  /** paid Claude calls Radar may start per hour, across all visitors */
  private readonly aiBudget: CallBudget;
  private readonly clientAi = new Map<string, number[]>();
  private readonly briefs = new Map<string, { at: number; brief: RadarBrief }>();

  constructor(private readonly d: RadarDeps) {
    this.clock = d.now ?? Date.now;
    this.aiBudget = new CallBudget(d.config.radar.aiCallsPerHour, 60 * MINUTE_MS);
  }

  /** Investigations running right now. */
  get running(): number {
    return this.active.size;
  }

  /**
   * Starts (or joins, for a repeat of a running or finished search within 20 s) an
   * investigation. Returns immediately. Throws RadarBusyError when too many run.
   */
  start(query: string, chain?: ChainId, opts: StartOpts = {}): RadarReport {
    const q = normalizeQuery(query);
    const now = this.clock();
    const key = `${chain ?? '*'}|${this.dedupeKey(q, chain)}`;
    const recent = this.recent.get(key);
    if (recent && now - recent.at < DEDUPE_WINDOW_MS) {
      const existing = this.get(recent.id);
      // a failed or empty search is run again: the retry may well succeed
      if (existing && (existing.status === 'running' || existing.status === 'done')) return existing;
    }
    this.pruneRecent(now);
    if (this.active.size >= MAX_ACTIVE_INVESTIGATIONS) throw new RadarBusyError(10);

    const inv: Investigation = {
      report: newReport(q, now),
      client: opts.client ?? null,
      aiCounted: false,
      adapter: null,
      needsLookup: false,
      history: [],
      holders: { state: 'pending' },
      savedAt: 0,
      saveTimer: null,
    };
    this.recent.set(key, { id: inv.report.id, at: now });
    this.active.set(inv.report.id, inv);
    this.save(inv, true);
    log.info('radar started', { id: inv.report.id, query: q, chain: chain ?? null });
    // next microtask: a caller subscribing right after start() sees every transition
    queueMicrotask(() => void this.run(inv, chain));
    return structuredClone(inv.report);
  }

  get(id: string): RadarReport | null {
    const live = this.active.get(id)?.report ?? this.touch(id);
    if (live) return structuredClone(live);
    try {
      const stored = this.d.db.getRadar(id);
      return stored ? markInterrupted(stored, this.clock()) : null;
    } catch (e) {
      log.warn('radar read failed', { id, error: errMsg(e) });
      return null;
    }
  }

  /**
   * Called synchronously with a full copy after every change, the last one
   * carrying the final status. Finished reports never change, so subscribing
   * to one is a no-op: read it with get().
   */
  subscribe(id: string, fn: (r: RadarReport) => void): () => void {
    if (!this.active.has(id)) return () => {};
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(fn);
    const subscribers = set;
    return () => {
      subscribers.delete(fn);
      if (subscribers.size === 0 && this.listeners.get(id) === subscribers) this.listeners.delete(id);
    };
  }

  /**
   * The dedupe key of a query: an address keeps its case where the chain's
   * addresses are case-sensitive (two base58 mints that differ only in case are
   * different tokens); a symbol or name is compared without case.
   */
  private dedupeKey(q: string, chain: ChainId | undefined): string {
    const adapters = chain ? this.d.adapters.filter((a) => a.config.id === chain) : this.d.adapters;
    const byAddress = adapters.filter((a) => a.isAddress(q));
    if (byAddress.length === 0) return q.toLowerCase();
    return byAddress.every((a) => a.normalizeAddress(q) === q.toLowerCase()) ? q.toLowerCase() : q;
  }

  /* ───────────────────────────── flow ───────────────────────────── */

  private async run(inv: Investigation, chain: ChainId | undefined): Promise<void> {
    const r = inv.report;
    try {
      const resolve = await this.stage(inv, 'resolve', (signal) => this.resolve(inv, chain, signal));
      if (resolve.error) {
        r.status = resolve.error instanceof NotFoundError ? 'not_found' : 'error';
        r.error = errMsg(resolve.error);
        return;
      }
      await this.stage(inv, 'onchain', (signal) => this.onchain(inv, signal));
      await this.stage(inv, 'holders', (signal) => this.holders(inv, signal));
      this.record(inv);
      await this.stage(inv, 'quant', () => this.quant(inv));
      await this.stage(inv, 'web', (signal) => this.web(inv, signal));
      await this.stage(inv, 'ai', (signal) => this.ai(inv, signal));
      r.status = 'done';
    } catch (e) {
      // stage() contains every stage failure; this is a bug guard
      log.error('radar run failed', { id: r.id, error: errMsg(e) });
      r.status = 'error';
      r.error = errMsg(e);
    } finally {
      this.finish(inv);
    }
  }

  /** Runs one stage within its deadline; at the deadline its work is cancelled through `signal`. */
  private async stage(
    inv: Investigation,
    id: RadarStageId,
    work: (signal: AbortSignal) => Promise<StageOutcome>,
  ): Promise<{ error: unknown }> {
    this.setStage(inv, id, { status: 'running', startedAt: this.clock() });
    const controller = new AbortController();
    const deadlineMs = STAGE_DEADLINE_MS[id];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${stageLabel(id)} did not finish within ${Math.round(deadlineMs / 1000)}s`));
      }, deadlineMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([work(controller.signal), deadline]);
      this.setStage(inv, id, { ...outcome, endedAt: this.clock() });
      return { error: null };
    } catch (e) {
      if (!(e instanceof NotFoundError)) log.warn('radar stage failed', { id: inv.report.id, stage: id, error: errMsg(e) });
      this.setStage(inv, id, { status: 'error', message: errMsg(e), endedAt: this.clock() });
      return { error: e };
    } finally {
      clearTimeout(timer);
      controller.abort(); // anything the stage left running (a losing branch, a late retry) stops here
    }
  }

  /* ───────────────────────────── stages ───────────────────────────── */

  private async resolve(inv: Investigation, chain: ChainId | undefined, signal: AbortSignal): Promise<StageOutcome> {
    const r = inv.report;
    if (r.query === '') throw new NotFoundError('Empty query');
    const adapters = chain ? this.d.adapters.filter((a) => a.config.id === chain) : this.d.adapters;
    if (adapters.length === 0) throw new NotFoundError(`Chain "${chain}" is not supported`);

    const call: CallOpts = { ...PROVIDER_CALL, signal };
    const byAddress = adapters.filter((a) => a.isAddress(r.query));
    const found =
      byAddress.length > 0 ? await lookupAddress(byAddress, r.query, call) : await searchTokens(adapters, r.query, call);
    const [top, ...others] = found;
    if (!top) {
      const where = (byAddress.length > 0 ? byAddress : adapters).map((a) => a.config.name).join(', ');
      throw new NotFoundError(
        byAddress.length > 0 ? `No token with address ${r.query} on ${where}` : `No token matching "${r.query}" on ${where}`,
      );
    }

    inv.adapter = top.adapter;
    inv.needsLookup = byAddress.length === 0;
    r.snapshot = top.snapshot;
    r.token = tokenRef(top.snapshot);
    r.candidates = others.slice(0, MAX_CANDIDATES).map((c) => tokenRef(c.snapshot));
    const via = byAddress.length > 0 ? 'address lookup' : 'DexScreener search';
    const more = r.candidates.length > 0 ? `; ${r.candidates.length} other match${r.candidates.length > 1 ? 'es' : ''}` : '';
    return done(`${label(top.snapshot)} on ${top.adapter.config.name} via ${via}${more}`);
  }

  private async onchain(inv: Investigation, signal: AbortSignal): Promise<StageOutcome> {
    const { adapter, report: r } = inv;
    if (!adapter || !r.snapshot) return skipped('Token not resolved');
    let snapshot = r.snapshot;
    let note = '';
    if (inv.needsLookup) {
      try {
        const full = await adapter.lookup(snapshot.address, { ...PROVIDER_CALL, signal });
        // the lookup's pool is authoritative; search data must not leak another pool's windows into it
        if (full) {
          snapshot = mergeSnapshots(full, {
            links: snapshot.links,
            boosted: snapshot.boosted,
            imageUrl: full.imageUrl ?? snapshot.imageUrl,
          });
        } else {
          note = ' · full lookup found no pool, using search data';
        }
      } catch (e) {
        note = ` · full lookup failed (${errMsg(e)}), using search data`;
      }
    }
    inv.history = this.history(snapshot);
    this.assess(inv, snapshot);
    const sources = snapshot.sources.length > 0 ? snapshot.sources.join(' + ') : 'no provider';
    const liquidity = snapshot.liquidityUsd !== null ? ` · liquidity ${fmtUsd(snapshot.liquidityUsd)}` : '';
    return done(`${sources}${liquidity} · ${inv.history.length} earlier snapshots${note}`);
  }

  private async holders(inv: Investigation, signal: AbortSignal): Promise<StageOutcome> {
    const { adapter, report: r } = inv;
    if (!adapter || !r.snapshot) return skipped('Token not resolved');
    const snapshot = r.snapshot;
    let enrichment;
    try {
      enrichment = await adapter.enrich(snapshot.address, { ...PROVIDER_CALL, signal });
    } catch (e) {
      inv.holders = { state: 'failed', error: errMsg(e) };
      this.refreshUnavailable(inv);
      throw e;
    }
    inv.holders = enrichment ? { state: 'ok' } : { state: 'missing' };
    this.assess(inv, enrichment ? mergeSnapshots(snapshot, enrichment) : snapshot);
    const s = r.snapshot;
    if (!enrichment) return done('Token not indexed by the holder data provider yet');
    if (s.holders === null) return done('Holder count not reported by the provider');
    const top10 = s.top10HolderPct !== null ? ` · top 10 hold ${s.top10HolderPct.toFixed(1)}%` : '';
    return done(`${s.holders.toLocaleString('en-US')} holders${top10}`);
  }

  private async quant(inv: Investigation): Promise<StageOutcome> {
    const r = inv.report;
    if (!r.snapshot || !r.metrics) return skipped('No on-chain metrics');
    r.quant = matchQuant(r.snapshot, r.metrics, this.d.regime());
    const top = r.quant.top;
    return done(top ? `Closest methodology: ${top.name} (${top.score}/100)` : 'No methodology resembles current conditions');
  }

  private async web(inv: Investigation, signal: AbortSignal): Promise<StageOutcome> {
    const r = inv.report;
    if (!r.snapshot) return skipped('Token not resolved');
    const query = intelQueryFor(r.snapshot);
    const { items, providers } = await gatherIntel(query, this.clock(), {
      signal,
      webResearch: this.webResearchPlan(inv, r.snapshot),
    });
    r.intel = items;
    r.providers = providers;
    const summary = providers.map((p) => (p.ok ? `${p.provider} ${p.count}` : `${p.provider} failed`)).join(' · ');
    if (providers.length > 0 && providers.every((p) => !p.ok)) throw new Error(`Every intel provider failed (${summary})`);
    return done(`${items.length} mention${items.length === 1 ? '' : 's'} · ${summary}`);
  }

  private async ai(inv: Investigation, signal: AbortSignal): Promise<StageOutcome> {
    const r = inv.report;
    if (!r.snapshot || !r.metrics || !r.detection || !r.quant) return skipped('Needs on-chain metrics and quant analysis');
    const now = this.clock();
    const key = tokenKey(r.snapshot.chain, r.snapshot.address);
    const reused = this.briefs.get(key);
    if (reused && now - reused.at < BRIEF_TTL_MS) {
      r.brief = reused.brief;
      const minutes = Math.max(1, Math.round((now - reused.at) / MINUTE_MS));
      return done(`Written by Claude (${reused.brief.model ?? 'model unknown'}) ${minutes} min ago for an earlier search of this token`);
    }
    const allowed = this.claudeAllowed(inv, now);
    r.brief = await writeRadarBrief(
      {
        snapshot: r.snapshot,
        metrics: r.metrics,
        detection: r.detection,
        quant: r.quant,
        intel: r.intel,
        providers: r.providers,
        lang: this.d.config.lang,
      },
      { claude: allowed === true, signal },
    );
    if (r.brief.engine === 'claude') {
      this.rememberBrief(key, now, r.brief);
      return done(`Written by Claude (${r.brief.model ?? 'model unknown'})`);
    }
    return done(allowed === true || allowed === null ? 'Written by the rules engine' : `Written by the rules engine (${allowed})`);
  }

  /* ───────────────────────────── AI spend ───────────────────────────── */

  /**
   * Whether this investigation may start a paid Claude call: true (counted against
   * the hourly budget and the visitor's quota), null when Claude is not configured,
   * or the reason it may not.
   */
  private claudeAllowed(inv: Investigation, now: number): true | null | string {
    if (!claudeSession()) return null;
    if (!this.clientMayUseAi(inv, now)) return 'per-visitor AI quota reached';
    if (!this.aiBudget.take(now)) return 'hourly AI budget reached';
    this.countClientAi(inv, now);
    return true;
  }

  /** Claude web research for this token: off by configuration, reused from cache, or within budget. */
  private webResearchPlan(inv: Investigation, s: TokenSnapshot): GatherOpts['webResearch'] {
    if (!this.d.config.radar.webResearch || !webResearchEnabled()) return { run: false, reason: null };
    const target = { chain: s.chain, address: s.address, symbol: s.symbol, name: s.name };
    if (hasCachedResearch(target)) return { run: true }; // no new spend
    const allowed = this.claudeAllowed(inv, this.clock());
    return allowed === true ? { run: true } : { run: false, reason: allowed ?? 'Claude not configured' };
  }

  private clientMayUseAi(inv: Investigation, now: number): boolean {
    if (inv.client === null || inv.aiCounted) return true;
    const recent = (this.clientAi.get(inv.client) ?? []).filter((t) => now - t < CLIENT_AI_WINDOW_MS);
    return recent.length < CLIENT_AI_INVESTIGATIONS;
  }

  private countClientAi(inv: Investigation, now: number): void {
    if (inv.client === null || inv.aiCounted) return;
    inv.aiCounted = true;
    const recent = (this.clientAi.get(inv.client) ?? []).filter((t) => now - t < CLIENT_AI_WINDOW_MS);
    recent.push(now);
    this.clientAi.delete(inv.client);
    this.clientAi.set(inv.client, recent);
    while (this.clientAi.size > CLIENT_LIMIT_ENTRIES) {
      const oldest = this.clientAi.keys().next().value;
      if (oldest === undefined) break;
      this.clientAi.delete(oldest);
    }
  }

  private rememberBrief(key: string, now: number, brief: RadarBrief): void {
    this.briefs.delete(key);
    this.briefs.set(key, { at: now, brief });
    while (this.briefs.size > BRIEF_CACHE_LIMIT) {
      const oldest = this.briefs.keys().next().value;
      if (oldest === undefined) break;
      this.briefs.delete(oldest);
    }
  }

  /* ───────────────────────────── helpers ───────────────────────────── */

  /** Metrics and detection for a (new) snapshot of the resolved token. */
  private assess(inv: Investigation, snapshot: TokenSnapshot): void {
    const r = inv.report;
    const { config } = this.d;
    const now = this.clock();
    r.snapshot = snapshot;
    r.token = tokenRef(snapshot);
    r.metrics = deriveMetrics(snapshot, inv.history, now);
    const launchRamp = this.d.baselines?.rampFor(snapshot.chain, now);
    r.detection = detectAnomalies(snapshot, r.metrics, detectOptions(config, launchRamp ? { launchRamp } : {}));
    this.refreshUnavailable(inv);
  }

  private history(s: TokenSnapshot): TokenSnapshot[] {
    try {
      return this.d.db.history(s.chain, s.address, this.clock() - HISTORY_MS);
    } catch (e) {
      log.warn('radar history read failed', { chain: s.chain, address: s.address, error: errMsg(e) });
      return [];
    }
  }

  /** Repeated searches of a token build the same history the scanner uses. */
  private record(inv: Investigation): void {
    const s = inv.report.snapshot;
    if (!s || s.symbol === '') return;
    try {
      this.d.db.insertSnapshot(s);
    } catch (e) {
      log.warn('radar snapshot write failed', { chain: s.chain, address: s.address, error: errMsg(e) });
    }
  }

  private refreshUnavailable(inv: Investigation): void {
    const r = inv.report;
    r.unavailable = r.snapshot ? unavailableFields(r.snapshot, r.metrics, inv.holders) : [smartMoney()];
  }

  private setStage(inv: Investigation, id: RadarStageId, patch: Partial<Omit<RadarStage, 'id' | 'label'>>): void {
    const stage = inv.report.stages.find((s) => s.id === id);
    if (stage) Object.assign(stage, patch);
    this.changed(inv);
  }

  private changed(inv: Investigation): void {
    inv.report.updatedAt = Math.max(inv.report.updatedAt, this.clock());
    this.save(inv);
    this.notify(inv);
  }

  private finish(inv: Investigation): void {
    const r = inv.report;
    if (r.status === 'running') r.status = 'done';
    for (const stage of r.stages) {
      if (stage.status === 'pending' || stage.status === 'running') stage.status = 'skipped';
    }
    r.updatedAt = Math.max(r.updatedAt, this.clock());
    this.save(inv, true);
    this.notify(inv);
    this.active.delete(r.id);
    this.listeners.delete(r.id);
    this.remember(r);
    log.info('radar finished', { id: r.id, status: r.status, ms: r.updatedAt - r.createdAt });
  }

  private notify(inv: Investigation): void {
    const set = this.listeners.get(inv.report.id);
    if (!set || set.size === 0) return;
    const copy = structuredClone(inv.report);
    for (const fn of [...set]) {
      try {
        fn(copy);
      } catch (e) {
        log.warn('radar subscriber threw', { id: inv.report.id, error: errMsg(e) });
      }
    }
  }

  /** At most one write per 300 ms while running; `force` writes now (first and final state). */
  private save(inv: Investigation, force = false): void {
    if (inv.saveTimer) {
      if (!force) return; // the pending write will pick up this change
      clearTimeout(inv.saveTimer);
      inv.saveTimer = null;
    }
    const wait = inv.savedAt + SAVE_INTERVAL_MS - Date.now();
    if (force || wait <= 0) {
      this.write(inv);
      return;
    }
    inv.saveTimer = setTimeout(() => {
      inv.saveTimer = null;
      this.write(inv);
    }, wait);
    inv.saveTimer.unref?.();
  }

  private write(inv: Investigation): void {
    inv.savedAt = Date.now();
    try {
      this.d.db.saveRadar(inv.report);
    } catch (e) {
      log.warn('radar save failed', { id: inv.report.id, error: errMsg(e) });
    }
  }

  private remember(r: RadarReport): void {
    this.reports.delete(r.id);
    this.reports.set(r.id, r);
    for (const id of this.reports.keys()) {
      if (this.reports.size <= MEMORY_REPORTS) break;
      this.reports.delete(id);
    }
  }

  private touch(id: string): RadarReport | null {
    const r = this.reports.get(id);
    if (!r) return null;
    this.remember(r);
    return r;
  }

  private pruneRecent(now: number): void {
    for (const [key, entry] of this.recent) {
      if (now - entry.at >= DEDUPE_WINDOW_MS) this.recent.delete(key);
    }
  }
}

/* ───────────────────────────── resolution ───────────────────────────── */

/**
 * `lookup` on every chain whose address format matches; most liquid first. When
 * several chains share the format (an EVM address), one DexScreener search first
 * tells which chains list the token, and only those are asked: a random address
 * costs one request, not two GeckoTerminal calls per EVM chain.
 */
async function lookupAddress(adapters: ChainAdapter[], address: string, call: CallOpts): Promise<Resolved[]> {
  let candidates = adapters;
  if (adapters.length > 1) {
    try {
      const listed = await dsSearch(address, call);
      candidates = adapters.filter((a) =>
        listed.some((s) => s.chain === a.config.dexscreenerChainId && a.normalizeAddress(s.address) === a.normalizeAddress(address)),
      );
      if (candidates.length === 0) return [];
    } catch (e) {
      if (call.signal?.aborted) throw e;
      // DexScreener unavailable: ask every candidate chain directly
      log.debug('radar address pre-check failed', { error: errMsg(e) });
    }
  }
  const results = await Promise.allSettled(candidates.map((a) => a.lookup(address, call)));
  const found: Resolved[] = [];
  const failures: string[] = [];
  results.forEach((res, i) => {
    const adapter = candidates[i];
    if (!adapter) return;
    if (res.status === 'rejected') failures.push(`${adapter.config.name}: ${errMsg(res.reason)}`);
    else if (res.value) found.push({ adapter, snapshot: res.value });
  });
  // "not found" is only claimed when every chain actually answered
  if (found.length === 0 && failures.length > 0) throw new Error(`Lookup failed (${failures.join('; ')})`);
  return found.sort((a, b) => byLiquidity(a.snapshot, b.snapshot));
}

/**
 * DexScreener search on supported chains: exact symbol/name matches first, then
 * by real trading activity, then by liquidity.
 *
 * - Symbols compare without a leading "$": some tokens put the cashtag in the
 *   on-chain symbol itself (dogwifhat's symbol is "$WIF").
 * - A ticker-like query is also searched as "$TICKER": DexScreener ranks text
 *   matches, so "WIF" alone can fill all 30 results with other chains' tokens
 *   and never reach the "$WIF" the reader means.
 * - Reported liquidity is not trusted to rank: a scam pool quoting a worthless
 *   token against 9 USDC can report $59M of "liquidity". Volume costs real money
 *   to produce, so 24 h volume decides first.
 */
async function searchTokens(adapters: ChainAdapter[], query: string, call: CallOpts): Promise<Resolved[]> {
  const byDsChain = new Map(adapters.map((a) => [a.config.dexscreenerChainId, a] as const));
  const bare = (text: string) => normalizeQuery(text).toLowerCase();
  const wanted = bare(query);
  const isExact = (s: TokenSnapshot) => bare(s.symbol) === wanted || bare(s.name) === wanted;

  const queries = TICKER_QUERY.test(query) ? [query, `$${query}`] : [query];
  const results = await Promise.allSettled(queries.map((q) => dsSearch(q, call)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length === results.length) throw failed[0]?.reason;

  const found = new Map<string, Resolved>();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const snap of r.value) {
      const adapter = byDsChain.get(snap.chain);
      if (!adapter) continue;
      const key = `${adapter.config.id}:${adapter.normalizeAddress(snap.address)}`;
      if (!found.has(key)) found.set(key, { adapter, snapshot: { ...snap, chain: adapter.config.id } });
    }
  }
  return [...found.values()].sort(
    (a, b) =>
      Number(isExact(b.snapshot)) - Number(isExact(a.snapshot)) ||
      activity(b.snapshot) - activity(a.snapshot) ||
      byLiquidity(a.snapshot, b.snapshot),
  );
}

/** A plain ticker ("WIF", "pepe2"): letters and digits, no spaces. */
const TICKER_QUERY = /^[A-Za-z0-9]{2,15}$/;

/** USD volume over the longest window the provider reported; unknown counts as none. */
function activity(s: TokenSnapshot): number {
  return s.volumeUsd.h24 ?? s.volumeUsd.h6 ?? s.volumeUsd.h1 ?? 0;
}

function byLiquidity(a: TokenSnapshot, b: TokenSnapshot): number {
  return (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1);
}

/* ───────────────────────────── report helpers ───────────────────────────── */

export function normalizeQuery(query: string): string {
  return query.trim().replace(/^\$+/, '').trim().slice(0, MAX_QUERY_CHARS);
}

function newReport(query: string, now: number): RadarReport {
  return {
    id: randomUUID(),
    query,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    error: null,
    stages: RADAR_STAGES.map(({ id, label }) => ({
      id,
      label,
      status: 'pending',
      message: null,
      startedAt: null,
      endedAt: null,
    })),
    candidates: [],
    token: null,
    snapshot: null,
    metrics: null,
    detection: null,
    quant: null,
    intel: [],
    providers: [],
    brief: null,
    unavailable: [smartMoney()],
  };
}

function stageLabel(id: RadarStageId): string {
  return RADAR_STAGES.find((s) => s.id === id)?.label ?? id;
}

function tokenRef(s: TokenSnapshot): TokenRef {
  return {
    chain: s.chain,
    address: s.address,
    symbol: s.symbol,
    name: s.name,
    liquidityUsd: s.liquidityUsd,
    marketCapUsd: s.marketCapUsd,
    createdAt: s.createdAt,
    imageUrl: s.imageUrl,
  };
}

/** "$WIF" — a symbol that already carries its cashtag ("$WIF" on-chain) is not prefixed twice. */
function label(s: TokenSnapshot): string {
  const symbol = s.symbol.replace(/^\$+/, '');
  return symbol ? `$${symbol}` : s.address;
}

function done(message: string | null): StageOutcome {
  return { status: 'done', message };
}

function skipped(message: string): StageOutcome {
  return { status: 'skipped', message };
}

function smartMoney(): UnavailableField {
  return { field: 'smartMoney', reason: SMART_MONEY_REASON };
}

const NOT_INDEXED = 'the token may not be indexed by the market-data providers yet';

/** Core fields we could not provide, each with the reason. Smart money is never available. */
export function unavailableFields(s: TokenSnapshot, m: DerivedMetrics | null, holders: HolderLookup): UnavailableField[] {
  const out: UnavailableField[] = [smartMoney()];
  const add = (field: string, reason: string) => out.push({ field, reason });
  if (s.holders === null && holders.state !== 'pending') add('holders', holdersReason(holders));
  if (s.liquidityUsd === null) add('liquidity', `No liquidity reported; ${NOT_INDEXED} or it has no pool.`);
  if (s.marketCapUsd === null) {
    add(
      'marketCap',
      s.fdvUsd !== null
        ? 'Providers report only the fully diluted valuation (FDV); circulating market cap is not available.'
        : `Market cap not reported; ${NOT_INDEXED}.`,
    );
  }
  if (!hasTxCounts(s)) add('txns', `Transaction counts not reported; ${NOT_INDEXED}.`);
  if (m?.ageMinutes == null) add('ageMinutes', 'Creation time not reported by the providers.');
  return out;
}

function holdersReason(h: HolderLookup): string {
  switch (h.state) {
    case 'failed':
      return `The holder data provider failed: ${h.error}`;
    case 'missing':
      return 'The token is not indexed by the holder data provider yet.';
    default:
      return 'The holder data provider did not report a holder count for this token.';
  }
}

function hasTxCounts(s: TokenSnapshot): boolean {
  return Object.values(s.txns).some((t) => t != null && (t.buys !== null || t.sells !== null));
}

/** A stored report still 'running' outlived its process (restart) and will never finish. */
function markInterrupted(r: RadarReport, now: number): RadarReport {
  if (r.status !== 'running') return r;
  return {
    ...r,
    status: 'error',
    error: 'Investigation interrupted (server restarted)',
    updatedAt: Math.max(r.updatedAt, now),
    stages: r.stages.map((s) => (s.status === 'pending' || s.status === 'running' ? { ...s, status: 'skipped' } : s)),
  };
}
