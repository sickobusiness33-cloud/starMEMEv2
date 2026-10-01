import { create } from 'zustand';
import type { ArticleResponse, ChainId, DetectionEvent, NewsArticle, Severity, Stats } from '@shared/types';
import { api, errorMessage } from './lib/api';

/**
 * Newsroom state. Everything here comes from the API (stream `hello` + live
 * events, or REST); nothing is synthesized.
 */

export const ARTICLE_CAP = 300;
export const DETECTION_CAP = 120;
const PAGE = 40;
/** how long an inserted card counts as "new" (enter animation / glow) */
const ENTER_WINDOW_MS = 1_500;
const DETAIL_TTL_MS = 20_000;

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'offline';
export type SeverityFilter = 'all' | 'ALERT' | 'BREAKING';

export interface FeedFilters {
  chain: ChainId | 'all';
  severity: SeverityFilter;
}

export interface EnterInfo {
  at: number;
  /** stagger delay (first render only) */
  delay: number;
  /** BREAKING arrival: one-shot green glow */
  glow: boolean;
}

export type DetailState =
  | { status: 'loading'; data: ArticleResponse | null; at: number }
  | { status: 'ready'; data: ArticleResponse; at: number }
  | { status: 'error'; data: ArticleResponse | null; error: string; at: number };

interface PageState {
  loading: boolean;
  error: string | null;
  /** filter keys whose server-side history is fully loaded */
  exhausted: Record<string, true>;
  /** filter keys already topped up from /api/feed */
  filled: Record<string, true>;
}

export interface State {
  stats: Stats | null;
  statsAt: number | null;
  /** visible feed, newest first */
  articles: NewsArticle[];
  /** arrived while the reader was not at the top of LIVE (shown behind the "↑ N new" pill) */
  buffered: NewsArticle[];
  enter: Record<string, EnterInfo>;
  detections: DetectionEvent[];
  detectionEnter: Record<string, number>;
  /** first snapshot received (stream hello or REST fallback) */
  hydrated: boolean;
  loadError: string | null;
  conn: ConnState;
  retryAt: number | null;
  filters: FeedFilters;
  expanded: Record<string, true>;
  details: Record<string, DetailState>;
  /** LIVE is the active tab, the page is visible and scrolled to the top of the feed */
  liveAtTop: boolean;
  pages: PageState;
  focus: { id: string; nonce: number } | null;
  radarFocusNonce: number;

  hello: (d: { stats: Stats; articles: NewsArticle[]; events: DetectionEvent[] }) => void;
  setStats: (stats: Stats) => void;
  ingestArticle: (a: NewsArticle) => 'shown' | 'buffered' | 'duplicate';
  ingestDetection: (e: DetectionEvent) => void;
  setConn: (conn: ConnState, retryAt?: number | null) => void;
  setLoadError: (msg: string | null) => void;
  setLiveAtTop: (v: boolean) => void;
  flushBuffered: () => void;
  setFilters: (patch: Partial<FeedFilters>) => void;
  toggleExpanded: (id: string) => void;
  setExpanded: (id: string, open: boolean) => void;
  loadDetail: (id: string, force?: boolean) => void;
  loadPage: (kind: 'fill' | 'older') => Promise<void>;
  focusArticle: (id: string) => Promise<void>;
  requestRadarFocus: () => void;
}

const byNewest = (a: NewsArticle, b: NewsArticle) => b.createdAt - a.createdAt;
const byNewestEvent = (a: DetectionEvent, b: DetectionEvent) => b.ts - a.ts;

function merge<T extends { id: string }>(list: T[], incoming: T[], cmp: (a: T, b: T) => number, cap: number): T[] {
  const seen = new Set(list.map((x) => x.id));
  const add: T[] = [];
  for (const x of incoming) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    add.push(x);
  }
  if (add.length === 0) return list;
  const out = list.concat(add).sort(cmp);
  return out.length > cap ? out.slice(0, cap) : out;
}

function pruneEnter<T>(map: Record<string, T>, at: (v: T) => number, now: number): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) if (now - at(v) < ENTER_WINDOW_MS * 2) out[k] = v;
  return out;
}

export function filterKey(f: FeedFilters): string {
  return `${f.chain}|${f.severity}`;
}

const ALL_KEY = filterKey({ chain: 'all', severity: 'all' });

export function matchesFilters(a: NewsArticle, f: FeedFilters): boolean {
  if (f.chain !== 'all' && a.chain !== f.chain) return false;
  if (f.severity !== 'all' && a.severity !== f.severity) return false;
  return true;
}

export function isEntering(info: EnterInfo | undefined, now: number): boolean {
  return info !== undefined && now - info.at < ENTER_WINDOW_MS;
}

export const useStore = create<State>()((set, get) => ({
  stats: null,
  statsAt: null,
  articles: [],
  buffered: [],
  enter: {},
  detections: [],
  detectionEnter: {},
  hydrated: false,
  loadError: null,
  conn: 'connecting',
  retryAt: null,
  filters: { chain: 'all', severity: 'all' },
  expanded: {},
  details: {},
  liveAtTop: false,
  pages: { loading: false, error: null, exhausted: {}, filled: {} },
  focus: null,
  radarFocusNonce: 0,

  hello: ({ stats, articles, events }) => {
    const s = get();
    const now = Date.now();
    if (!s.hydrated) {
      const list = merge([], articles, byNewest, ARTICLE_CAP);
      // first render of the list: a short stagger on the first six cards replaces the skeleton swap
      const enter: Record<string, EnterInfo> = {};
      list.slice(0, 6).forEach((a, i) => (enter[a.id] = { at: now, delay: i * 40, glow: false }));
      set({
        stats,
        statsAt: now,
        articles: list,
        enter,
        detections: merge([], events, byNewestEvent, DETECTION_CAP),
        hydrated: true,
        loadError: null,
        pages: {
          ...s.pages,
          filled: { [ALL_KEY]: true },
          exhausted: articles.length < PAGE ? { [ALL_KEY]: true } : {},
        },
      });
      return;
    }
    // reconnect: the snapshot may hold stories published while we were away
    set({ stats, statsAt: now, loadError: null });
    const fresh = articles.filter((a) => !s.articles.some((x) => x.id === a.id)).sort(byNewest);
    for (const a of fresh.reverse()) get().ingestArticle(a);
    for (const e of [...events].sort(byNewestEvent).reverse()) get().ingestDetection(e);
  },

  setStats: (stats) => set({ stats, statsAt: Date.now() }),

  ingestArticle: (a) => {
    const s = get();
    if (s.articles.some((x) => x.id === a.id) || s.buffered.some((x) => x.id === a.id)) return 'duplicate';
    const now = Date.now();
    if (s.liveAtTop) {
      set({
        articles: merge(s.articles, [a], byNewest, ARTICLE_CAP),
        enter: { ...pruneEnter(s.enter, (v) => v.at, now), [a.id]: { at: now, delay: 0, glow: a.severity === 'BREAKING' } },
      });
      return 'shown';
    }
    set({ buffered: merge(s.buffered, [a], byNewest, ARTICLE_CAP) });
    return 'buffered';
  },

  ingestDetection: (e) => {
    const s = get();
    if (s.detections.some((x) => x.id === e.id)) return;
    const now = Date.now();
    set({
      detections: merge(s.detections, [e], byNewestEvent, DETECTION_CAP),
      detectionEnter: { ...pruneEnter(s.detectionEnter, (v) => v, now), [e.id]: now },
    });
  },

  setConn: (conn, retryAt = null) => {
    const s = get();
    if (s.conn === conn && s.retryAt === retryAt) return;
    set({ conn, retryAt });
  },

  setLoadError: (msg) => set({ loadError: msg }),

  setLiveAtTop: (v) => {
    if (get().liveAtTop === v) return;
    set({ liveAtTop: v });
    if (v) get().flushBuffered();
  },

  flushBuffered: () => {
    const s = get();
    if (s.buffered.length === 0) return;
    const now = Date.now();
    const enter = pruneEnter(s.enter, (v) => v.at, now);
    for (const a of s.buffered) enter[a.id] = { at: now, delay: 0, glow: a.severity === 'BREAKING' };
    set({ articles: merge(s.articles, s.buffered, byNewest, ARTICLE_CAP), buffered: [], enter });
  },

  setFilters: (patch) => {
    const filters = { ...get().filters, ...patch };
    set({ filters, pages: { ...get().pages, error: null } });
  },

  toggleExpanded: (id) => get().setExpanded(id, !get().expanded[id]),

  setExpanded: (id, open) => {
    const expanded = { ...get().expanded };
    if (open) expanded[id] = true;
    else delete expanded[id];
    set({ expanded });
    if (open) get().loadDetail(id);
  },

  loadDetail: (id, force = false) => {
    const prev = get().details[id];
    if (prev?.status === 'loading') return;
    if (prev?.status === 'ready' && !force && Date.now() - prev.at < DETAIL_TTL_MS) return;
    const put = (d: DetailState) => set({ details: { ...get().details, [id]: d } });
    put({ status: 'loading', data: prev?.data ?? null, at: Date.now() });
    api
      .article(id)
      .then((data) => put({ status: 'ready', data, at: Date.now() }))
      .catch((e: unknown) => put({ status: 'error', data: prev?.data ?? null, error: errorMessage(e), at: Date.now() }));
  },

  loadPage: async (kind) => {
    const s = get();
    const key = filterKey(s.filters);
    if (s.pages.loading || s.pages.exhausted[key]) return;
    if (kind === 'fill' && s.pages.filled[key]) return;
    if (kind === 'older' && s.articles.length >= ARTICLE_CAP) return;
    const visible = s.articles.filter((a) => matchesFilters(a, s.filters));
    const oldest = visible.at(-1);
    const before = kind === 'older' && oldest ? oldest.createdAt : null;
    set({ pages: { ...s.pages, loading: true, error: null } });
    try {
      const res = await api.feed({
        limit: PAGE,
        before,
        chain: s.filters.chain === 'all' ? null : s.filters.chain,
        severity: s.filters.severity === 'all' ? null : (s.filters.severity as Severity),
      });
      const cur = get();
      const pages = { ...cur.pages, loading: false };
      if (res.nextBefore === null || res.articles.length < PAGE) pages.exhausted = { ...pages.exhausted, [key]: true };
      pages.filled = { ...pages.filled, [key]: true };
      // older pages land below the fold: no enter animation, no buffering
      set({ articles: merge(cur.articles, res.articles, byNewest, ARTICLE_CAP), pages });
    } catch (e) {
      set({ pages: { ...get().pages, loading: false, error: errorMessage(e) } });
    }
  },

  focusArticle: async (id) => {
    let s = get();
    if (!s.articles.some((a) => a.id === id) && !s.buffered.some((a) => a.id === id)) {
      try {
        const res = await api.article(id);
        s = get();
        set({
          articles: merge(s.articles, [res.article], byNewest, ARTICLE_CAP),
          details: { ...s.details, [id]: { status: 'ready', data: res, at: Date.now() } },
        });
      } catch {
        return;
      }
    }
    get().flushBuffered();
    s = get();
    const article = s.articles.find((a) => a.id === id);
    if (article && !matchesFilters(article, s.filters)) set({ filters: { chain: 'all', severity: 'all' } });
    get().setExpanded(id, true);
    set({ focus: { id, nonce: Date.now() } });
  },

  requestRadarFocus: () => set({ radarFocusNonce: get().radarFocusNonce + 1 }),
}));
