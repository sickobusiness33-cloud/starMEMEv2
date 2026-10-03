/*
 * Radar web intel: every provider in parallel with its own timeout, then a
 * relevance filter (no false positives for generic symbols), URL dedupe and
 * freshness ranking. One provider failing never fails the whole search, and a
 * provider that timed out is cancelled (its queued requests leave the limiter,
 * its Claude call is aborted) instead of running on unobserved.
 */
import type { IntelItem, IntelProviderStatus, TokenSnapshot } from '../../../../shared/types.js';
import { researchWeb, webResearchEnabled } from '../../ai/web-research.js';
import { errMsg, logger } from '../../log.js';
import { addressKey } from '../../sources/merge.js';
import { classifyFreshness, FUTURE_TOLERANCE_MS } from '../freshness.js';
import * as biz from './biz.js';
import * as gdelt from './gdelt.js';
import * as hn from './hn.js';
import { intelTerms, urlText, type IntelQuery, type IntelTerms, type MatchedOn } from './match.js';
import * as official from './official.js';

export type { IntelQuery } from './match.js';

const log = logger('intel');

const MAX_ITEMS = 60;
const DEFAULT_TIMEOUT_MS = 12_000;
/** GDELT is serialized at one request per 5.5 s, so it may queue behind other searches */
const GDELT_TIMEOUT_MS = 20_000;
/** Claude web research runs several searches server-side; its own request timeout is config.ai.timeoutMs */
const WEB_RESEARCH_TIMEOUT_MS = 60_000;

export type ProviderStatus = IntelProviderStatus;

interface Provider {
  name: string;
  timeoutMs: number;
  /** a provider that is not configured is left out of the run and of the status list */
  enabled?: () => boolean;
  /** must give up (reject) when `signal` fires: the run has timed out or was cancelled */
  search(t: IntelQuery, signal: AbortSignal): Promise<IntelItem[]>;
}

const CLAUDE_WEB = 'claude-web';

const PROVIDERS: Provider[] = [
  { name: 'gdelt', timeoutMs: GDELT_TIMEOUT_MS, search: (t, signal) => gdelt.search(t, { signal }) },
  { name: 'hn', timeoutMs: DEFAULT_TIMEOUT_MS, search: (t, signal) => hn.search(t, { signal }) },
  { name: 'biz', timeoutMs: DEFAULT_TIMEOUT_MS, search: (t, signal) => biz.search(t, { signal }) },
  { name: 'official', timeoutMs: DEFAULT_TIMEOUT_MS, search: (t) => official.search(t) },
  {
    name: CLAUDE_WEB,
    timeoutMs: WEB_RESEARCH_TIMEOUT_MS,
    enabled: webResearchEnabled,
    search: (t, signal) => researchWeb({ chain: t.chain, address: t.address, symbol: t.symbol, name: t.name }, { signal }),
  },
];

/**
 * Providers that matched the token in the full article text, beyond the title
 * and snippet we receive: their hits are kept without textual evidence when the
 * search terms were specific enough to trust that match. Claude web search is not
 * one of them: its result blocks are the search engine's raw hits, so each one
 * needs the same textual evidence as any other provider's.
 */
const FULL_TEXT_TRUST: Record<string, 'distinctive'> = {
  gdelt: 'distinctive',
};

/** General-audience sources, where a token name is often just a word (GDELT queries add crypto context themselves). */
const NEEDS_CRYPTO_CONTEXT = new Set(['hn']);

export interface GatherOpts {
  /** the caller gave up (e.g. the Radar stage deadline): every provider is cancelled */
  signal?: AbortSignal;
  /**
   * Claude web research (paid per search): run it (default), or skip it with the
   * reason shown in its status (e.g. the hourly AI budget is spent). A null reason
   * leaves it out entirely, as when it is not configured (turned off by the operator).
   */
  webResearch?: { run: true } | { run: false; reason: string | null };
}

export async function gatherIntel(
  t: IntelQuery,
  now: number,
  opts: GatherOpts = {},
): Promise<{ items: IntelItem[]; providers: ProviderStatus[] }> {
  const terms = intelTerms(t);
  const web = opts.webResearch ?? { run: true };
  const active = PROVIDERS.filter((p) => (p.enabled?.() ?? true) && !(p.name === CLAUDE_WEB && !web.run && web.reason === null));
  const runs = await Promise.all(
    active.map((p) =>
      p.name === CLAUDE_WEB && !web.run
        ? Promise.resolve<ProviderRun>({ name: p.name, items: [], error: `not run: ${web.reason}` })
        : runProvider(p, t, opts.signal),
    ),
  );
  const providers: ProviderStatus[] = [];
  const relevant: IntelItem[] = [];
  for (const run of runs) {
    const kept = filterRelevant(run.items, terms, now);
    providers.push({ provider: run.name, ok: run.error === null, count: kept.length, error: run.error });
    relevant.push(...kept);
  }
  return { items: rankIntel(dedupeByUrl(relevant)), providers };
}

interface ProviderRun {
  name: string;
  items: IntelItem[];
  error: string | null;
}

/** One provider within its time budget; at the deadline (or the caller's cancel) its work is aborted. */
async function runProvider(p: Provider, t: IntelQuery, parent?: AbortSignal): Promise<ProviderRun> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  parent?.addEventListener('abort', cancel, { once: true });
  if (parent?.aborted) controller.abort();
  try {
    const work = Promise.resolve().then(() => p.search(t, controller.signal));
    const items = await withTimeout(work, p.timeoutMs, p.name, controller);
    return { name: p.name, items: items.filter(isWellFormed), error: null };
  } catch (e) {
    const error = parent?.aborted ? `${p.name} cancelled` : errMsg(e);
    log.warn('intel provider failed', { provider: p.name, symbol: t.symbol, error });
    return { name: p.name, items: [], error };
  } finally {
    parent?.removeEventListener('abort', cancel);
  }
}

/* ───────────────────────────── relevance ───────────────────────────── */

/**
 * Keeps items with evidence that they are about this token and records what
 * matched. Contract-address matches always survive; a generic symbol alone never does.
 * Freshness is recomputed against `now`.
 */
export function filterRelevant(items: IntelItem[], q: IntelQuery | IntelTerms, now: number): IntelItem[] {
  const terms = 'match' in q ? q : intelTerms(q);
  return items.flatMap((item) => {
    const matchedOn = relevanceOf(item, terms);
    if (!matchedOn) return [];
    return [{ ...item, matchedOn, freshness: classifyFreshness(item.publishedAt, now, item.publishedPrecision) }];
  });
}

function relevanceOf(item: IntelItem, terms: IntelTerms): MatchedOn | null {
  // the project's own channels come from the market-data providers, never from a search
  if (item.sourceType === 'official' && item.provider !== CLAUDE_WEB) return 'project';
  const found = terms.match(`${item.title}\n${item.snippet ?? ''}\n${urlText(item.url)}`, {
    needsContext: NEEDS_CRYPTO_CONTEXT.has(item.provider),
  });
  if (found) return found;
  const trust = FULL_TEXT_TRUST[item.provider];
  // a full-text match is about the token, never "the project's own channel"
  return trust === 'distinctive' && terms.distinctive && item.matchedOn !== 'project' ? item.matchedOn : null;
}

function isWellFormed(item: IntelItem): boolean {
  return typeof item.title === 'string' && item.title.trim() !== '' && /^https?:\/\//i.test(item.url);
}

/* ───────────────────────────── dedupe & ranking ───────────────────────────── */

const MATCH_STRENGTH: Record<MatchedOn, number> = { contract: 3, name: 2, symbol: 1, project: 0 };
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref_src']);

/** Same article from two providers (or with tracking params) → one item, keeping the richest fields. */
export function dedupeByUrl(items: IntelItem[]): IntelItem[] {
  const byUrl = new Map<string, IntelItem>();
  for (const item of items) {
    const key = normalizeUrl(item.url);
    const prev = byUrl.get(key);
    if (!prev) {
      byUrl.set(key, item);
      continue;
    }
    const datedPrev = prev.publishedAt !== null;
    byUrl.set(key, {
      ...prev,
      publishedAt: datedPrev ? prev.publishedAt : item.publishedAt,
      freshness: datedPrev ? prev.freshness : item.freshness,
      ...(datedPrev
        ? prev.publishedPrecision !== undefined
          ? { publishedPrecision: prev.publishedPrecision }
          : {}
        : item.publishedPrecision !== undefined
          ? { publishedPrecision: item.publishedPrecision }
          : {}),
      snippet: prev.snippet ?? item.snippet,
      matchedOn: MATCH_STRENGTH[item.matchedOn] > MATCH_STRENGTH[prev.matchedOn] ? item.matchedOn : prev.matchedOn,
    });
  }
  return [...byUrl.values()];
}

/** Lowercase host without "www.", no scheme, fragment, utm_* / click ids or trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key) || TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    const host = u.host.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    const query = u.searchParams.toString();
    return `${host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** Newest first, undated after dated, the project's own channels last; at most 60. */
export function rankIntel(items: IntelItem[]): IntelItem[] {
  const own = items.filter((i) => i.sourceType === 'official');
  const coverage = items
    .filter((i) => i.sourceType !== 'official')
    .sort((a, b) => (b.publishedAt ?? Number.NEGATIVE_INFINITY) - (a.publishedAt ?? Number.NEGATIVE_INFINITY));
  return [...coverage.slice(0, Math.max(0, MAX_ITEMS - own.length)), ...own].slice(0, MAX_ITEMS);
}

/* ───────────────────────────── quick mentions ───────────────────────────── */

const MENTIONS_TTL_MS = 5 * 60_000;
/** a failed lookup is retried sooner than a successful one is refreshed */
const MENTIONS_FAILURE_TTL_MS = 60_000;
const MENTIONS_WINDOW_MS = 2 * 60 * 60_000;
/** the detection pipeline awaits this; keep it short */
const MENTIONS_TIMEOUT_MS = 8_000;
const MENTIONS_CACHE_LIMIT = 1_000;

const mentionsCache = new Map<string, { expiresAt: number; value: Promise<number | null> }>();

/**
 * Relevant Hacker News + /biz/ mentions published in the last 2 hours, cached
 * 5 minutes per token. Counts what the providers that answered returned; null
 * when none answered. Never throws.
 *
 * Only mentions of the contract address or of a distinctive name count: this
 * feeds the score of tokens that are often minutes old, and a ticker or cashtag
 * alone (even a non-generic one) is as likely to be about an older token with the
 * same ticker as about this one.
 */
export function quickMentions(s: TokenSnapshot): Promise<number | null> {
  const key = `${s.chain}:${addressKey(s.address)}`;
  const now = Date.now();
  const hit = mentionsCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const value = countRecentMentions(intelQueryFor(s));
  const entry = { expiresAt: now + MENTIONS_TTL_MS, value };
  mentionsCache.delete(key);
  mentionsCache.set(key, entry);
  void value.then((count) => {
    if (count === null) entry.expiresAt = Math.min(entry.expiresAt, Date.now() + MENTIONS_FAILURE_TTL_MS);
  });
  pruneMentionsCache(now);
  return value;
}

export function intelQueryFor(s: TokenSnapshot): IntelQuery {
  return { symbol: s.symbol, name: s.name, address: s.address, chain: s.chain, links: s.links };
}

async function countRecentMentions(t: IntelQuery): Promise<number | null> {
  const sources: Provider[] = [
    { name: 'hn', timeoutMs: MENTIONS_TIMEOUT_MS, search: (q, signal) => hn.search(q, { includeAddress: false, signal }) },
    { name: 'biz', timeoutMs: MENTIONS_TIMEOUT_MS, search: (q, signal) => biz.search(q, { signal }) },
  ];
  const runs = await Promise.all(sources.map((p) => runProvider(p, t)));
  if (runs.every((r) => r.error !== null)) return null;
  const now = Date.now();
  const terms = intelTerms(t);
  return dedupeByUrl(runs.flatMap((r) => filterRelevant(r.items, terms, now))).filter((i) => {
    if (i.matchedOn !== 'contract' && i.matchedOn !== 'name') return false;
    if (i.publishedAt === null) return false;
    const age = now - i.publishedAt;
    return age <= MENTIONS_WINDOW_MS && age >= -FUTURE_TOLERANCE_MS;
  }).length;
}

function pruneMentionsCache(now: number): void {
  if (mentionsCache.size <= MENTIONS_CACHE_LIMIT) return;
  for (const [key, entry] of mentionsCache) {
    if (entry.expiresAt <= now) mentionsCache.delete(key);
  }
  for (const key of mentionsCache.keys()) {
    if (mentionsCache.size <= MENTIONS_CACHE_LIMIT) break;
    mentionsCache.delete(key);
  }
}

/** Test hook. */
export function resetIntelState(): void {
  mentionsCache.clear();
}

/* ───────────────────────────── helpers ───────────────────────────── */

/** Rejects at the deadline and aborts the work through `controller`, so it stops instead of running on unobserved. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
      controller.abort();
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
