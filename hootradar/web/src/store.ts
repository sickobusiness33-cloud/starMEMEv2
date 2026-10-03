import { create } from 'zustand';
import type { ArticleResponse, ChainId, DetectionEvent, NewsArticle, Severity, Stats } from '@shared/types';
import { api, ApiError, errorMessage } from './lib/api';

/**
 * Newsroom state. Everything here comes from the API (stream `hello` + live
 * events, or REST); nothing is synthesized.
 *
 * Feed windows. All filters share one `articles` array, so a filter's view is
 * only trustworthy down to the point where its history is known to be complete
 * in memory. `pages.cursor[key]` is that point for a filter key: every story
 * matching the key with `createdAt >= cursor` is in `articles`. A view shows
 * exactly that contiguous range (plus stories opened directly by id, which are
 * marked as out of sequence), so a narrow filter's older top-up never shows up
 * in another filter as a silent hole, and "Load older" always continues from
 * the view's own cursor.
 */

/** max stories a single view holds (older pages stop here) and the memory target */
export const ARTICLE_CAP = 300;
export const DETECTION_CAP = 120;
export const PAGE = 40;
/** stories that arrived while the reader was away (beyond this the oldest are dropped, see pendingFloor) */
const BUFFER_CAP = ARTICLE_CAP;
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

export interface PageState {
  loading: boolean;
  error: string | null;
  /** per filter key: every matching story with createdAt >= cursor is in memory (exclusive `before` for the next page) */
  cursor: Record<string, number>;
  /** filter keys whose whole server-side history is in memory */
  exhausted: Record<string, true>;
  /** filter keys already topped up once automatically */
  filled: Record<string, true>;
}

export type ArrivalResult = 'shown' | 'buffered' | 'duplicate';
export type FocusResult = { ok: true } | { ok: false; message: string };

export interface State {
  stats: Stats | null;
  statsAt: number | null;
  /** every story in memory, newest first (views filter it, see viewOf) */
  articles: NewsArticle[];
  /** arrived while the reader was not at the top of LIVE (shown behind the "↑ N new" pill) */
  buffered: NewsArticle[];
  /**
   * Set when the stories in `buffered` do not connect to `articles` (a long disconnect,
   * or more arrivals than BUFFER_CAP): applied as a new floor for every view on flush.
   */
  pendingFloor: number | null;
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
  /** stories opened directly by id (toast, tape): always visible in LIVE, never evicted */
  pinned: Record<string, true>;
  focus: { id: string; nonce: number } | null;
  radarFocusNonce: number;
  /** latest polite screen-reader announcement for LIVE (see lib/announce) */
  announce: { text: string; id: number } | null;

  /** returns how each story of a reconnect snapshot was handled (empty on first hydration) */
  hello: (d: { stats: Stats; articles: NewsArticle[]; events: DetectionEvent[] }) => Array<{ article: NewsArticle; result: ArrivalResult }>;
  setStats: (stats: Stats) => void;
  ingestArticle: (a: NewsArticle) => ArrivalResult;
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
  focusArticle: (id: string) => Promise<FocusResult>;
  requestRadarFocus: () => void;
  setAnnounce: (text: string) => void;
}

const byNewest = (a: NewsArticle, b: NewsArticle) => b.createdAt - a.createdAt;
const byNewestEvent = (a: DetectionEvent, b: DetectionEvent) => b.ts - a.ts;

function merge<T extends { id: string }>(list: T[], incoming: T[], cmp: (a: T, b: T) => number, cap = Infinity): T[] {
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

function parseKey(key: string): FeedFilters {
  const i = key.lastIndexOf('|');
  return { chain: key.slice(0, i) as FeedFilters['chain'], severity: key.slice(i + 1) as SeverityFilter };
}

const ALL: FeedFilters = { chain: 'all', severity: 'all' };
const ALL_KEY = filterKey(ALL);

export function matchesFilters(a: NewsArticle, f: FeedFilters): boolean {
  if (f.chain !== 'all' && a.chain !== f.chain) return false;
  if (f.severity !== 'all' && a.severity !== f.severity) return false;
  return true;
}

export function isEntering(info: EnterInfo | undefined, now: number): boolean {
  return info !== undefined && now - info.at < ENTER_WINDOW_MS;
}

/** The key itself and every broader key: a complete range for a broader filter is complete for this one too. */
function supersetKeys(f: FeedFilters): string[] {
  return [
    ...new Set([
      filterKey(f),
      filterKey({ chain: f.chain, severity: 'all' }),
      filterKey({ chain: 'all', severity: f.severity }),
      ALL_KEY,
    ]),
  ];
}

/**
 * Oldest createdAt down to which the view for `f` is complete: -Infinity when its whole
 * history is in memory, null before anything is known (not hydrated).
 */
export function rangeFloor(pages: PageState, f: FeedFilters): number | null {
  let floor: number | null = null;
  for (const k of supersetKeys(f)) {
    if (pages.exhausted[k]) return -Infinity;
    const c = pages.cursor[k];
    if (c !== undefined && (floor === null || c < floor)) floor = c;
  }
  return floor;
}

/** Stories LIVE shows for `filters`: the contiguous range down to `floor`, plus stories opened directly. */
export function viewFrom(
  articles: NewsArticle[],
  filters: FeedFilters,
  floor: number | null,
  pinned: Record<string, true>,
): NewsArticle[] {
  const narrow = filters.chain !== 'all' || filters.severity !== 'all';
  if (!narrow && (floor === null || floor === -Infinity)) return articles;
  return articles.filter((a) => matchesFilters(a, filters) && (floor === null || a.createdAt >= floor || pinned[a.id] === true));
}

export function viewOf(s: Pick<State, 'articles' | 'filters' | 'pages' | 'pinned'>): NewsArticle[] {
  return viewFrom(s.articles, s.filters, rangeFloor(s.pages, s.filters), s.pinned);
}

/**
 * Keep memory bounded without ever breaking a view's contiguity: the newest
 * ARTICLE_CAP stories of the current view and pinned stories are kept; others go
 * oldest first, and every filter whose range lost a story has its cursor raised
 * past it (so "Load older" re-fetches it rather than skipping it).
 */
function evict(
  articles: NewsArticle[],
  pages: PageState,
  filters: FeedFilters,
  pinned: Record<string, true>,
): { articles: NewsArticle[]; pages: PageState } {
  if (articles.length <= ARTICLE_CAP) return { articles, pages };
  const keep = new Set(Object.keys(pinned));
  const floor = rangeFloor(pages, filters);
  let inView = 0;
  for (const a of articles) {
    if (inView >= ARTICLE_CAP) break;
    if (matchesFilters(a, filters) && (floor === null || a.createdAt >= floor)) {
      keep.add(a.id);
      inView += 1;
    }
  }
  let excess = articles.length - ARTICLE_CAP;
  const dropped: NewsArticle[] = [];
  for (let i = articles.length - 1; i >= 0 && excess > 0; i--) {
    const a = articles[i];
    if (!a || keep.has(a.id)) continue;
    dropped.push(a);
    excess -= 1;
  }
  if (dropped.length === 0) return { articles, pages };
  const gone = new Set(dropped.map((a) => a.id));
  const cursor = { ...pages.cursor };
  const exhausted = { ...pages.exhausted };
  for (const key of new Set([ALL_KEY, ...Object.keys(cursor), ...Object.keys(exhausted)])) {
    const f = parseKey(key);
    let newest = -Infinity;
    for (const d of dropped) if (d.createdAt > newest && matchesFilters(d, f)) newest = d.createdAt;
    if (newest === -Infinity) continue;
    const raised = newest + 1;
    if (exhausted[key]) {
      delete exhausted[key];
      cursor[key] = raised;
    } else if (cursor[key] === undefined || cursor[key] < raised) {
      cursor[key] = raised;
    }
  }
  return { articles: articles.filter((a) => !gone.has(a.id)), pages: { ...pages, cursor, exhausted } };
}

/** Stories below `floor` may be missing (missed while disconnected): no view may claim them as contiguous. */
function applyFloor(pages: PageState, floor: number): PageState {
  const cursor = { ...pages.cursor };
  for (const key of new Set([ALL_KEY, ...Object.keys(cursor), ...Object.keys(pages.exhausted)])) {
    if (cursor[key] === undefined || cursor[key] < floor) cursor[key] = floor;
  }
  return { ...pages, cursor, exhausted: {}, filled: {} };
}

export const useStore = create<State>()((set, get) => ({
  stats: null,
  statsAt: null,
  articles: [],
  buffered: [],
  pendingFloor: null,
  enter: {},
  detections: [],
  detectionEnter: {},
  hydrated: false,
  loadError: null,
  conn: 'connecting',
  retryAt: null,
  filters: ALL,
  expanded: {},
  details: {},
  liveAtTop: false,
  pages: { loading: false, error: null, cursor: {}, exhausted: {}, filled: {} },
  pinned: {},
  focus: null,
  radarFocusNonce: 0,
  announce: null,

  hello: ({ stats, articles, events }) => {
    const s = get();
    const now = Date.now();
    if (!s.hydrated) {
      const list = merge([], articles, byNewest);
      // first render of the list: a short stagger on the first six cards replaces the skeleton swap
      const enter: Record<string, EnterInfo> = {};
      list.slice(0, 6).forEach((a, i) => (enter[a.id] = { at: now, delay: i * 40, glow: false }));
      const oldest = list.at(-1);
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
          cursor: oldest && list.length >= PAGE ? { [ALL_KEY]: oldest.createdAt } : {},
          exhausted: list.length < PAGE ? { [ALL_KEY]: true } : {},
        },
      });
      return [];
    }
    // Reconnect: the snapshot (the newest PAGE stories) may hold stories published while we were away.
    set({ stats, statsAt: now, loadError: null });
    const known = new Set<string>();
    let newestKnown = -Infinity;
    for (const a of s.articles.concat(s.buffered)) {
      known.add(a.id);
      if (a.createdAt > newestKnown) newestKnown = a.createdAt;
    }
    const fresh = articles.filter((a) => !known.has(a.id)).sort(byNewest);
    const oldestFresh = fresh.at(-1);
    // A full snapshot that shares nothing with what we have and starts after our newest story
    // means stories were published in between that we never received: a gap.
    const gap =
      oldestFresh !== undefined &&
      newestKnown !== -Infinity &&
      fresh.length === articles.length &&
      articles.length >= PAGE &&
      oldestFresh.createdAt > newestKnown;
    if (gap) set({ pendingFloor: Math.max(get().pendingFloor ?? -Infinity, oldestFresh.createdAt) });
    const out: Array<{ article: NewsArticle; result: ArrivalResult }> = [];
    for (const a of [...fresh].reverse()) out.push({ article: a, result: get().ingestArticle(a) });
    for (const e of [...events].sort(byNewestEvent).reverse()) get().ingestDetection(e);
    // already at the top: nothing to wait for, the floor applies now
    if (gap && get().liveAtTop) get().flushBuffered();
    return out;
  },

  setStats: (stats) => set({ stats, statsAt: Date.now() }),

  ingestArticle: (a) => {
    const s = get();
    if (s.articles.some((x) => x.id === a.id) || s.buffered.some((x) => x.id === a.id)) return 'duplicate';
    const now = Date.now();
    if (s.liveAtTop) {
      if (s.buffered.length > 0 || s.pendingFloor !== null) get().flushBuffered();
      const cur = get();
      const next = evict(merge(cur.articles, [a], byNewest), cur.pages, cur.filters, cur.pinned);
      set({
        articles: next.articles,
        pages: next.pages,
        enter: { ...pruneEnter(cur.enter, (v) => v.at, now), [a.id]: { at: now, delay: 0, glow: a.severity === 'BREAKING' } },
      });
      return 'shown';
    }
    const buffered = merge(s.buffered, [a], byNewest, BUFFER_CAP);
    // the oldest waiting stories were dropped: what is left no longer connects to the feed
    const floor = s.buffered.length >= BUFFER_CAP ? (buffered.at(-1)?.createdAt ?? null) : null;
    set({
      buffered,
      pendingFloor: floor === null ? s.pendingFloor : Math.max(s.pendingFloor ?? -Infinity, floor),
    });
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
    if (s.buffered.length === 0 && s.pendingFloor === null) return;
    const now = Date.now();
    const enter = pruneEnter(s.enter, (v) => v.at, now);
    for (const a of s.buffered) enter[a.id] = { at: now, delay: 0, glow: a.severity === 'BREAKING' };
    const pages = s.pendingFloor === null ? s.pages : applyFloor(s.pages, s.pendingFloor);
    const next = evict(merge(s.articles, s.buffered, byNewest), pages, s.filters, s.pinned);
    set({ articles: next.articles, pages: next.pages, buffered: [], pendingFloor: null, enter });
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

  /**
   * One page older than the current view's floor. 'fill' is the automatic top-up a
   * narrow filter gets once; 'older' is the reader asking for more. A request that
   * arrives while another is in flight is dropped here and retried by the caller
   * (LiveView re-runs its fill effect when `pages.loading` settles).
   */
  loadPage: async (kind) => {
    const s = get();
    const filters = s.filters;
    const key = filterKey(filters);
    if (s.pages.loading) return;
    const floor = rangeFloor(s.pages, filters);
    if (floor === -Infinity) return; // the whole history for this filter is in memory
    if (kind === 'fill' && s.pages.filled[key]) return;
    if (kind === 'older' && viewOf(s).length >= ARTICLE_CAP) return;
    set({ pages: { ...s.pages, loading: true, error: null } });
    try {
      const res = await api.feed({
        limit: PAGE,
        before: floor,
        chain: filters.chain === 'all' ? null : filters.chain,
        severity: filters.severity === 'all' ? null : (filters.severity as Severity),
      });
      const cur = get();
      let pages: PageState = { ...cur.pages, loading: false, filled: { ...cur.pages.filled, [key]: true } };
      // The page continues the range only if the range did not move while it was in flight
      // (an eviction or a reconnect gap); otherwise its stories are kept but not trusted as contiguous.
      if (rangeFloor(cur.pages, filters) === floor) {
        const oldest = res.articles.at(-1);
        if (res.nextBefore === null || res.articles.length < PAGE) {
          pages = { ...pages, exhausted: { ...pages.exhausted, [key]: true } };
        } else if (oldest) {
          pages = { ...pages, cursor: { ...pages.cursor, [key]: Math.min(pages.cursor[key] ?? Infinity, oldest.createdAt) } };
        }
      }
      // older pages land below the fold: no enter animation, no buffering
      const next = evict(merge(cur.articles, res.articles, byNewest), pages, cur.filters, cur.pinned);
      set({ articles: next.articles, pages: next.pages });
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
          articles: merge(s.articles, [res.article], byNewest),
          details: { ...s.details, [id]: { status: 'ready', data: res, at: Date.now() } },
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return { ok: false, message: 'This story is no longer available.' };
        return { ok: false, message: `Could not open the story — ${errorMessage(e)}` };
      }
    }
    // pinned: visible whatever the view's range, and never evicted
    set({ pinned: { ...get().pinned, [id]: true } });
    get().flushBuffered();
    s = get();
    const article = s.articles.find((a) => a.id === id);
    if (!article) return { ok: false, message: 'This story could not be shown.' };
    if (!matchesFilters(article, s.filters)) set({ filters: ALL });
    get().setExpanded(id, true);
    set({ focus: { id, nonce: Date.now() } });
    return { ok: true };
  },

  requestRadarFocus: () => set({ radarFocusNonce: get().radarFocusNonce + 1 }),

  setAnnounce: (text) => {
    const id = (get().announce?.id ?? 0) + 1;
    // a trailing no-break space on every other message: identical text is still a change to the live region
    set({ announce: { text: id % 2 === 0 ? `${text} ` : text, id } });
  },
}));
