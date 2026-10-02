import { randomUUID } from 'node:crypto';
import type {
  ChainId,
  DerivedMetrics,
  Detection,
  DetectionEvent,
  MarketRegime,
  NewsArticle,
  PipelineTimings,
  Severity,
  TimeWindow,
  TokenLink,
  TokenSnapshot,
  TxCounts,
} from '../../../shared/types.js';
import { writeArticle } from '../ai/newswriter.js';
import type { ChainAdapter, TokenEnrichment } from '../chains/types.js';
import type { AppConfig } from '../config.js';
import { tokenKey, type Db } from '../db/db.js';
import type { DistributionQueue } from '../distribution/queue.js';
import { errMsg, logger } from '../log.js';
import { matchQuant } from '../quant/matcher.js';
import { detectAnomalies, SIGNAL_MAX_WEIGHTS } from './anomaly.js';
import type { Bus } from './bus.js';
import { deriveMetrics, toCardMetrics } from './metrics.js';

const log = logger('pipeline');

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const HISTORY_MS = 90 * MINUTE_MS;
const ENRICH_TTL_MS = 3 * MINUTE_MS;
const ENRICH_CACHE_SOFT_LIMIT = 500;
/** A token gets at most one stored detection per window unless its score jumps. */
const DETECTION_DEDUPE_MS = 10 * MINUTE_MS;
const DETECTION_DEDUPE_SCORE_JUMP = 10;
/** Inside the article cooldown a follow-up needs an escalation or this much extra score. */
const FOLLOW_UP_SCORE_JUMP = 15;
const CAP_WARN_INTERVAL_MS = 5 * MINUTE_MS;

const SEVERITY_RANK: Record<Severity, number> = { WATCH: 1, ALERT: 2, BREAKING: 3 };

export interface PipelineDeps {
  db: Db;
  bus: Bus;
  config: AppConfig;
  adapters: ChainAdapter[];
  distribution: DistributionQueue;
  regime: () => MarketRegime;
  mentions?: (s: TokenSnapshot) => Promise<number | null>;
  /** test seams; default to the real implementations */
  quant?: typeof matchQuant;
  writer?: typeof writeArticle;
  now?: () => number;
}

/** Everything known about a token at one decision point. */
interface Assessment {
  snapshot: TokenSnapshot;
  metrics: DerivedMetrics;
  detection: Detection;
  mentions: number | null;
}

/**
 * Decides what each refreshed snapshot deserves: nothing, a WATCH detection, or a
 * full article (enrich → quant → AI write → publish → distribution queue).
 */
export class Pipeline {
  private readonly quant: typeof matchQuant;
  private readonly writer: typeof writeArticle;
  private readonly clock: () => number;
  private readonly adapters: Map<ChainId, ChainAdapter>;
  private readonly enrichCache = new Map<string, { at: number; data: TokenEnrichment | null }>();
  /** tokens whose article is being prepared right now */
  private readonly inFlight = new Set<string>();
  private lastCapWarnAt = 0;

  constructor(private readonly d: PipelineDeps) {
    this.quant = d.quant ?? matchQuant;
    this.writer = d.writer ?? writeArticle;
    this.clock = d.now ?? Date.now;
    this.adapters = new Map(d.adapters.map((a) => [a.config.id, a]));
  }

  /** Called by the scanner for every refreshed snapshot. Never throws. */
  async process(s: TokenSnapshot, now: number): Promise<void> {
    try {
      const detectedAt = this.clock();
      const first = await this.assess(s, now);
      const severity = first.detection.severity;
      if (!severity) return;
      if (severity === 'WATCH') {
        this.recordDetection(first, now, null);
        return;
      }
      await this.escalate(first, now, detectedAt);
    } catch (e) {
      log.error('process failed', { chain: s.chain, address: s.address, error: errMsg(e) });
    }
  }

  /* ───────────── decision ───────────── */

  private async assess(s: TokenSnapshot, now: number, knownMentions?: number | null): Promise<Assessment> {
    const history = this.d.db.history(s.chain, s.address, now - HISTORY_MS);
    const metrics = deriveMetrics(s, history, now);
    let detection = this.detect(s, metrics, knownMentions ?? null);
    let mentions = knownMentions ?? null;
    if (knownMentions === undefined && this.socialCouldMatter(detection)) {
      mentions = await this.socialMentions(s);
      if (mentions != null) detection = this.detect(s, metrics, mentions);
    }
    return { snapshot: s, metrics, detection, mentions };
  }

  private detect(s: TokenSnapshot, m: DerivedMetrics, socialMentions: number | null): Detection {
    const { thresholds, scan } = this.d.config;
    return detectAnomalies(s, m, {
      thresholds,
      minLiquidityUsd: scan.minLiquidityUsd,
      minVolumeH1Usd: scan.minVolumeH1Usd,
      socialMentions,
    });
  }

  /** Mentions are looked up only when they could lift the token to WATCH or beyond. */
  private socialCouldMatter(d: Detection): boolean {
    if (!this.d.mentions || d.rejected.length) return false;
    return d.score + SIGNAL_MAX_WEIGHTS.social_attention >= this.d.config.thresholds.WATCH;
  }

  private async socialMentions(s: TokenSnapshot): Promise<number | null> {
    try {
      return (await this.d.mentions?.(s)) ?? null;
    } catch (e) {
      log.debug('mentions lookup failed', { chain: s.chain, symbol: s.symbol, error: errMsg(e) });
      return null;
    }
  }

  /** ALERT/BREAKING path. Enrichment only happens when an article is actually on the table. */
  private async escalate(first: Assessment, now: number, detectedAt: number): Promise<void> {
    const s = first.snapshot;
    const key = tokenKey(s.chain, s.address);
    if (this.inFlight.has(key)) return;

    const previous = this.d.db.lastArticleFor(s.chain, s.address);
    const blocked = this.publishBlocker(first, previous, now);
    if (blocked) {
      this.recordDetection(first, now, null);
      log.debug('article suppressed', { chain: s.chain, symbol: s.symbol, reason: blocked });
      return;
    }

    this.inFlight.add(key);
    try {
      const enriched = await this.enrich(s, now);
      const final = enriched === s ? first : await this.assess(enriched, now, first.mentions);
      const analyzedAt = this.clock();
      if (!final.detection.severity) return; // e.g. enrichment revealed a honeypot
      const blockedNow = this.publishBlocker(final, previous, now);
      if (blockedNow) {
        this.recordDetection(final, now, null);
        log.debug('article suppressed after enrichment', { chain: s.chain, symbol: s.symbol, reason: blockedNow });
        return;
      }
      await this.publish(final, previous, now, detectedAt, analyzedAt);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Reason an article must not be written for this assessment, or null when it may. */
  private publishBlocker(a: Assessment, previous: NewsArticle | null, now: number): string | null {
    const { config, db } = this.d;
    const severity = a.detection.severity;
    if (!severity || severity === 'WATCH') return 'below ALERT';
    if (a.snapshot.security?.honeypot === 'yes') return 'honeypot';
    if (!config.autopublish) return 'autopublish disabled';
    if (previous && !this.followUpAllowed(previous, a.detection, now)) return 'cooldown';

    const key = tokenKey(a.snapshot.chain, a.snapshot.address);
    const otherWrites = this.inFlight.size - (this.inFlight.has(key) ? 1 : 0);
    if (db.articlesSince(now - HOUR_MS) + otherWrites >= config.maxArticlesPerHour) {
      if (now - this.lastCapWarnAt > CAP_WARN_INTERVAL_MS) {
        this.lastCapWarnAt = now;
        log.warn('hourly article cap reached', { maxArticlesPerHour: config.maxArticlesPerHour });
      }
      return 'hourly cap';
    }
    return null;
  }

  private followUpAllowed(previous: NewsArticle, d: Detection, now: number): boolean {
    if (!this.withinCooldown(previous, now)) return true;
    const escalated = d.severity != null && SEVERITY_RANK[d.severity] > SEVERITY_RANK[previous.severity];
    return escalated || d.score >= previous.score + FOLLOW_UP_SCORE_JUMP;
  }

  private withinCooldown(previous: NewsArticle, now: number): boolean {
    return now - previous.createdAt < this.d.config.articleCooldownMin * MINUTE_MS;
  }

  /* ───────────── enrichment ───────────── */

  /**
   * Adds holders / concentration / security from the chain adapter (cached per
   * token). Freshly fetched data is also stored as a snapshot so holder growth
   * can be measured across our own history.
   */
  private async enrich(s: TokenSnapshot, now: number): Promise<TokenSnapshot> {
    const adapter = this.adapters.get(s.chain);
    if (!adapter) return s;
    const key = tokenKey(s.chain, s.address);
    const cached = this.enrichCache.get(key);
    if (cached && now - cached.at < ENRICH_TTL_MS) {
      return cached.data ? applyEnrichment(s, cached.data, (a) => adapter.normalizeAddress(a)) : s;
    }

    let data: TokenEnrichment | null = null;
    try {
      data = await adapter.enrich(s.address);
    } catch (e) {
      log.warn('enrich failed', { chain: s.chain, symbol: s.symbol, error: errMsg(e) });
    }
    this.cacheEnrichment(key, now, data);
    if (!data) return s;
    const enriched = applyEnrichment(s, data, (a) => adapter.normalizeAddress(a));
    this.d.db.insertSnapshot(enriched);
    return enriched;
  }

  private cacheEnrichment(key: string, now: number, data: TokenEnrichment | null): void {
    if (this.enrichCache.size >= ENRICH_CACHE_SOFT_LIMIT) {
      for (const [k, v] of this.enrichCache) if (now - v.at >= ENRICH_TTL_MS) this.enrichCache.delete(k);
    }
    this.enrichCache.set(key, { at: now, data });
  }

  /* ───────────── publishing ───────────── */

  private async publish(
    a: Assessment,
    previous: NewsArticle | null,
    now: number,
    detectedAt: number,
    analyzedAt: number,
  ): Promise<void> {
    const { config, db, bus } = this.d;
    const s = a.snapshot;
    const severity = a.detection.severity;
    if (!severity) return;
    const quant = this.quant(s, a.metrics, this.d.regime(), { socialMentions: a.mentions });
    const quantAt = this.clock();
    const followUpOf = previous && this.withinCooldown(previous, now) ? previous : null;
    const draft = await this.writer({
      snapshot: s,
      metrics: a.metrics,
      detection: a.detection,
      quant,
      lang: config.lang,
      previous: followUpOf,
    });
    const writtenAt = this.clock();
    const publishedAt = this.clock();
    const timings: PipelineTimings = { detectedAt, analyzedAt, quantAt, writtenAt, publishedAt };

    const article: NewsArticle = {
      id: randomUUID(),
      createdAt: publishedAt,
      chain: s.chain,
      address: s.address,
      symbol: s.symbol,
      name: s.name,
      imageUrl: s.imageUrl,
      severity,
      score: a.detection.score,
      headline: draft.headline,
      lede: draft.lede,
      aiLine: draft.aiLine,
      whyItMatters: draft.whyItMatters,
      quantAnalysis: draft.quantAnalysis,
      outlook: draft.outlook,
      engine: draft.engine,
      model: draft.model,
      lang: draft.lang,
      metrics: toCardMetrics(s, a.metrics),
      signals: a.detection.signals,
      quant: { top: quant.top, matches: quant.matches, regime: quant.regime, riskFlags: quant.riskFlags },
      pipeline: timings,
      links: this.links(s),
      updateOf: followUpOf?.id ?? null,
    };

    db.insertArticle(article);
    this.enqueueDistribution(article);
    bus.emit('article', article);
    this.recordDetection(a, now, article.id, { dedupe: false });
    log.info('article published', {
      chain: s.chain,
      symbol: s.symbol,
      severity: article.severity,
      score: article.score,
      engine: article.engine,
      updateOf: article.updateOf,
      latencyMs: publishedAt - detectedAt,
    });
  }

  private enqueueDistribution(article: NewsArticle): void {
    try {
      this.d.distribution.enqueue(article);
    } catch (e) {
      log.error('distribution enqueue failed', { articleId: article.id, error: errMsg(e) });
    }
  }

  private links(s: TokenSnapshot): NewsArticle['links'] {
    const adapter = this.adapters.get(s.chain);
    const first = (type: TokenLink['type']) => s.links.find((l) => l.type === type)?.url ?? null;
    return {
      dexscreener: adapter ? `https://dexscreener.com/${adapter.config.dexscreenerChainId}/${s.address}` : null,
      explorer: adapter ? adapter.config.explorerTokenUrl(s.address) : null,
      website: first('website'),
      twitter: first('twitter'),
      telegram: first('telegram'),
    };
  }

  /* ───────────── detections ───────────── */

  private recordDetection(a: Assessment, now: number, articleId: string | null, o = { dedupe: true }): void {
    const severity = a.detection.severity;
    if (!severity) return;
    const s = a.snapshot;
    if (o.dedupe) {
      const last = this.d.db.lastDetectionFor(s.chain, s.address);
      if (last && now - last.ts < DETECTION_DEDUPE_MS && a.detection.score < last.score + DETECTION_DEDUPE_SCORE_JUMP) {
        return;
      }
    }
    const event: DetectionEvent = {
      id: randomUUID(),
      ts: now,
      chain: s.chain,
      address: s.address,
      symbol: s.symbol,
      name: s.name,
      score: a.detection.score,
      severity,
      signals: a.detection.signals,
      articleId,
    };
    this.d.db.insertDetection(event);
    this.d.bus.emit('detection', event);
  }
}

/**
 * Enrichment values are fresher than whatever the market snapshot carried. Wallet
 * counts are added only when they describe the same pool as the snapshot.
 */
function applyEnrichment(s: TokenSnapshot, e: TokenEnrichment, normalize: (address: string) => string): TokenSnapshot {
  const samePool =
    e.wallets?.pairAddress != null && s.pairAddress != null && normalize(e.wallets.pairAddress) === normalize(s.pairAddress);
  return {
    ...s,
    txns: samePool && e.wallets ? withWalletCounts(s.txns, e.wallets.txns) : s.txns,
    holders: e.holders ?? s.holders,
    top10HolderPct: e.top10HolderPct ?? s.top10HolderPct,
    security: e.security ?? s.security,
    imageUrl: s.imageUrl ?? e.imageUrl ?? null,
    links: mergeLinks(s.links, e.links ?? []),
    createdAt: earliest(s.createdAt, e.poolCreatedAt ?? null),
  };
}

/** Earliest known time; a token is at least as old as any of its pools. */
function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** Unique buyers/sellers from the enrichment; trade counts stay those of the market snapshot when it has them. */
function withWalletCounts(market: TokenSnapshot['txns'], wallets: TokenSnapshot['txns']): TokenSnapshot['txns'] {
  const out: TokenSnapshot['txns'] = { ...market };
  for (const [w, counts] of Object.entries(wallets) as Array<[TimeWindow, TxCounts | undefined]>) {
    if (!counts) continue;
    const base = market[w];
    out[w] = {
      buys: base?.buys ?? counts.buys,
      sells: base?.sells ?? counts.sells,
      buyers: counts.buyers ?? base?.buyers ?? null,
      sellers: counts.sellers ?? base?.sellers ?? null,
    };
  }
  return out;
}

function mergeLinks(a: TokenLink[], b: TokenLink[]): TokenLink[] {
  const seen = new Set(a.map((l) => l.url));
  return [...a, ...b.filter((l) => !seen.has(l.url))];
}
