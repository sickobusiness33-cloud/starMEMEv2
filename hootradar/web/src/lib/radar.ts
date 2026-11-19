import { create } from 'zustand';
import type { ChainId, RadarReport, RadarStreamEvent } from '@shared/types';
import { api, ApiError, errorMessage, isAbortError, radarStreamUrl } from './api';
import { fmtTicker } from './format';

/**
 * Radar investigations: POST /api/radar → follow /api/radar/:id/stream.
 * The server closes the stream after `end`; we close our EventSource first so
 * the browser does not reconnect. If the stream fails we fall back to polling
 * GET /api/radar/:id until the report is final.
 */

export interface RecentSearch {
  q: string;
  chain: ChainId | null;
  /** resolved "$SYMBOL" once the investigation found the token */
  label: string | null;
  at: number;
}

export type RadarPhase = 'idle' | 'starting' | 'streaming' | 'done' | 'error';

interface RadarState {
  query: string | null;
  chain: ChainId | null;
  phase: RadarPhase;
  report: RadarReport | null;
  error: string | null;
  /** rate-limited (429) until this time (client clock, ms); new investigations wait for it */
  retryUntil: number | null;
  /**
   * Client clock minus server clock (ms), estimated from report frames
   * (smallest observed `Date.now() - report.updatedAt`). Lets the UI time a
   * running stage from its server `startedAt` without trusting either clock alone.
   */
  skewMs: number | null;
  recent: RecentSearch[];
  /** POST a new investigation; false (and nothing changes) while rate-limited */
  run: (query: string, chain: ChainId | null) => boolean;
  /**
   * Show an investigation already run in this session (history back/forward to its hash):
   * the finished report from memory, or re-attach to a running one. False if none is known.
   */
  resume: (query: string, chain: ChainId | null) => boolean;
  reset: () => void;
  removeRecent: (r: RecentSearch) => void;
  clearRecent: () => void;
}

const RECENT_KEY = 'hootradar:recent-searches';
const RECENT_MAX = 8;
const POLL_MS = 1_500;
const POLL_MAX_ERRORS = 5;

function loadRecent(): RecentSearch[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((r): r is RecentSearch => !!r && typeof r === 'object' && typeof (r as RecentSearch).q === 'string')
      .map((r) => ({
        q: r.q.slice(0, 120),
        chain: typeof r.chain === 'string' ? r.chain : null,
        label: typeof r.label === 'string' ? r.label : null,
        at: typeof r.at === 'number' ? r.at : 0,
      }))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function saveRecent(list: RecentSearch[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // private mode / storage blocked: recent searches simply do not persist
  }
}

const sameSearch = (a: { q: string; chain: ChainId | null }, b: { q: string; chain: ChainId | null }) =>
  a.q.toLowerCase() === b.q.toLowerCase() && a.chain === b.chain;

/**
 * Investigations run in this session, by query + chain: browser history between radar hashes
 * shows these instead of POSTing again (each POST costs one of the rate limit's few tokens
 * and would throw away a finished report). Only an explicit search or Re-run starts a new one.
 */
const CACHE_MAX = 12;
const cache = new Map<string, { id: string; report: RadarReport | null }>();
const cacheKey = (q: string, chain: ChainId | null) => `${q.toLowerCase()}|${chain ?? '*'}`;

function remember(q: string, chain: ChainId | null, id: string, report: RadarReport | null): void {
  const k = cacheKey(q, chain);
  cache.delete(k); // re-insert: most recent last
  cache.set(k, { id, report });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Without a Retry-After header the limiter's window (1 min) is the honest upper bound. */
const DEFAULT_RETRY_SEC = 60;

/** Seconds left on a radar rate limit, or 0. */
export function rateLimitLeft(retryUntil: number | null, now: number): number {
  return retryUntil === null ? 0 : Math.max(0, Math.ceil((retryUntil - now) / 1000));
}

let source: EventSource | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let abort: AbortController | null = null;
let runSeq = 0;

function stopActive(): void {
  if (source) {
    source.onerror = null;
    source.close();
  }
  source = null;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  abort?.abort();
  abort = null;
}

export const useRadar = create<RadarState>()((set, get) => {
  const isCurrent = (seq: number) => seq === runSeq;

  const accept = (seq: number, report: RadarReport) => {
    if (!isCurrent(seq)) return;
    const observed = Date.now() - report.updatedAt;
    const prevSkew = get().skewMs;
    set({ report, skewMs: prevSkew === null ? observed : Math.min(prevSkew, observed) });
    const { query, chain } = get();
    if (query) remember(query, chain, report.id, report);
    if (report.token && query) {
      const label = fmtTicker(report.token.symbol);
      const recent = get().recent.map((r) => (sameSearch(r, { q: query, chain }) && r.label !== label ? { ...r, label } : r));
      if (recent.some((r, i) => r !== get().recent[i])) {
        set({ recent });
        saveRecent(recent);
      }
    }
    if (report.status !== 'running') finish(seq);
  };

  const finish = (seq: number) => {
    if (!isCurrent(seq)) return;
    stopActive();
    set({ phase: 'done' });
  };

  const poll = (seq: number, id: string, errors: number) => {
    pollTimer = setTimeout(() => {
      api
        .radar(id, abort?.signal)
        .then((r) => {
          accept(seq, r);
          if (isCurrent(seq) && r.status === 'running') poll(seq, id, 0);
        })
        .catch((e: unknown) => {
          if (!isCurrent(seq) || isAbortError(e)) return;
          if (errors + 1 >= POLL_MAX_ERRORS) set({ phase: 'error', error: errorMessage(e) });
          else poll(seq, id, errors + 1);
        });
    }, errors === 0 ? POLL_MS : POLL_MS * 2 ** errors);
  };

  const follow = (seq: number, id: string) => {
    set({ phase: 'streaming' });
    const es = new EventSource(radarStreamUrl(id));
    source = es;
    const onFrame = (ev: Event) => {
      if (source !== es) return;
      try {
        const event = JSON.parse((ev as MessageEvent<string>).data) as RadarStreamEvent;
        if (event?.report) accept(seq, event.report);
        if (event?.type === 'end') finish(seq);
      } catch {
        // ignore a malformed frame; the next one carries the full report again
      }
    };
    es.addEventListener('report', onFrame);
    es.addEventListener('end', onFrame);
    es.onerror = () => {
      if (source !== es) return;
      es.onerror = null;
      es.close();
      source = null;
      if (isCurrent(seq) && get().phase === 'streaming') poll(seq, id, 0);
    };
  };

  return {
    query: null,
    chain: null,
    phase: 'idle',
    report: null,
    error: null,
    retryUntil: null,
    skewMs: null,
    recent: loadRecent(),

    run: (query, chain) => {
      const q = query.trim().slice(0, 120);
      if (!q) return false;
      if (rateLimitLeft(get().retryUntil, Date.now()) > 0) return false;
      stopActive();
      const seq = ++runSeq;
      const prior = get().recent.find((r) => sameSearch(r, { q, chain }));
      const recent = [{ q, chain, label: prior?.label ?? null, at: Date.now() }, ...get().recent.filter((r) => !sameSearch(r, { q, chain }))].slice(
        0,
        RECENT_MAX,
      );
      saveRecent(recent);
      set({ query: q, chain, phase: 'starting', report: null, error: null, retryUntil: null, skewMs: null, recent });
      abort = new AbortController();
      api
        .startRadar(q, chain, abort.signal)
        .then(({ id }) => {
          if (!isCurrent(seq)) return;
          remember(q, chain, id, null);
          follow(seq, id);
        })
        .catch((e: unknown) => {
          if (!isCurrent(seq) || isAbortError(e)) return;
          const limited = e instanceof ApiError && e.status === 429;
          set({
            phase: 'error',
            error: errorMessage(e),
            retryUntil: limited ? Date.now() + (e.retryAfterSec ?? DEFAULT_RETRY_SEC) * 1000 : null,
          });
        });
      return true;
    },

    resume: (query, chain) => {
      const q = query.trim().slice(0, 120);
      const hit = q ? cache.get(cacheKey(q, chain)) : undefined;
      if (!hit) return false;
      stopActive();
      const seq = ++runSeq;
      const final = hit.report !== null && hit.report.status !== 'running';
      set({ query: q, chain, phase: final ? 'done' : 'starting', report: hit.report, error: null, skewMs: null });
      // still running when we left it: follow it again by id (GET + stream), no new POST
      if (!final) {
        abort = new AbortController();
        follow(seq, hit.id);
      }
      return true;
    },

    reset: () => {
      stopActive();
      runSeq++;
      set({ query: null, chain: null, phase: 'idle', report: null, error: null, retryUntil: null, skewMs: null });
    },

    removeRecent: (r) => {
      const recent = get().recent.filter((x) => !sameSearch(x, r));
      saveRecent(recent);
      set({ recent });
    },

    clearRecent: () => {
      saveRecent([]);
      set({ recent: [] });
    },
  };
});

/** Hash params describing the current investigation (so the RADAR tab returns to it). */
export function currentRadarParams(): Record<string, string | null> {
  const { query, chain } = useRadar.getState();
  return query ? { q: query, chain } : {};
}
