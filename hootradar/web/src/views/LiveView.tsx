import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type FlatIndexLocationWithAlign, type ListItem, type VirtuosoHandle } from 'react-virtuoso';
import type { NewsArticle } from '@shared/types';
import {
  ARTICLE_CAP,
  atOrAbove,
  filterKey,
  isComplete,
  matchesFilters,
  rangeFloor,
  useStore,
  viewFrom,
  type EnterInfo,
  type FeedPos,
  type SeverityFilter,
} from '../store';
import { reconnectNow } from '../lib/stream';
import { noteFlushed } from '../lib/announce';
import { STATUS_COLOR } from '../lib/chains';
import { useClock } from '../lib/time';
import { shortSince } from '../lib/format';
import { useMediaQuery, WIDE_QUERY } from '../lib/media';
import { NewsCard } from '../components/NewsCard';
import { SignalTape } from '../components/SignalTape';
import { PipelinePanel } from '../components/PipelinePanel';
import { ChainsPanel } from '../components/ChainsPanel';
import { IconArrowUp } from '../components/Icons';

const VIRTUALIZE_AFTER = 50;
/** within this many px of the top the reader is "looking at the top of the feed" */
const AT_TOP_PX = 48;
/** a narrow filter tops itself up from the server (once) while its view shows fewer stories than this */
const FILL_BELOW = 20;
/** first-layout height guess for a virtualized card until it is measured */
const DEFAULT_CARD_PX = 200;

/* ───────────── LIVE memory across tab switches ─────────────
 * Only the active tab's view is mounted, so LIVE remounts on every return. The
 * plain list renders in full and App restores the window scroll; the virtualized
 * list renders nothing until it has measured the viewport, so it is restored to
 * the card the reader had at the top of the screen, and the feed keeps its old
 * height meanwhile so the browser never clamps the restored scroll position. */

interface Anchor {
  id: string;
  /** px from the viewport top to the card's top edge */
  top: number;
}

const memory: { y: number; anchor: Anchor | null; height: number; cardPx: number } = {
  y: 0,
  anchor: null,
  height: 0,
  cardPx: DEFAULT_CARD_PX,
};

/** Focus requests (toast "View", tape row) already applied; a remount must not replay an old one. */
let handledFocusNonce = 0;

export function LiveView() {
  // Below 1100px the rail would sit under an endless feed: the tape (the proof the engine is
  // working) moves above it in a compact form, pipeline and chains stay below.
  const wide = useMediaQuery(WIDE_QUERY);
  useLiveAtTop();

  return (
    <div className="live">
      <LiveAnnouncer />
      <div className="live__feed">
        {!wide && (
          <div className="live__tape">
            <SignalTape compact />
          </div>
        )}
        <FeedToolbar />
        <Feed wide={wide} />
      </div>
      <aside className="live__rail" aria-label="Engine activity">
        {wide && <SignalTape />}
        <PipelinePanel />
        <ChainsPanel />
      </aside>
    </div>
  );
}

/**
 * One visually hidden polite region for LIVE (see lib/announce): new stories, batched.
 * The feed list and the tape are deliberately not live regions (far too chatty).
 */
function LiveAnnouncer() {
  const announce = useStore((s) => s.announce);
  // a message from before this mount is old news: the region starts empty
  const [since] = useState(() => useStore.getState().announce?.id ?? 0);
  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announce && announce.id > since ? announce.text : ''}
    </p>
  );
}

/** Tracks whether the reader is at the top of LIVE (drives buffering and BREAKING toasts). */
function useLiveAtTop() {
  const setLiveAtTop = useStore((s) => s.setLiveAtTop);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      setLiveAtTop(document.visibilityState === 'visible' && window.scrollY <= AT_TOP_PX);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    document.addEventListener('visibilitychange', update);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', schedule);
      document.removeEventListener('visibilitychange', update);
      setLiveAtTop(false);
    };
  }, [setLiveAtTop]);
}

/* ───────────── toolbar ───────────── */

const SEVERITIES: Array<{ id: SeverityFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'ALERT', label: 'Alert' },
  { id: 'BREAKING', label: 'Breaking' },
];

function FeedToolbar() {
  const chains = useStore((s) => s.stats?.chains);
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);

  return (
    <div className="toolbar">
      <div className="toolbar__group" role="group" aria-label="Filter by chain">
        <button type="button" className="chip" aria-pressed={filters.chain === 'all'} onClick={() => setFilters({ chain: 'all' })}>
          All
        </button>
        {(chains ?? []).map((c) => (
          <button
            key={c.id}
            type="button"
            className="chip"
            aria-pressed={filters.chain === c.id}
            onClick={() => setFilters({ chain: c.id })}
            title={c.name}
          >
            <span className="dot" style={{ ['--dot' as string]: c.color }} aria-hidden="true" />
            {c.short}
          </button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Filter by severity">
        {SEVERITIES.map((s) => (
          <button
            key={s.id}
            type="button"
            className="seg__btn"
            aria-pressed={filters.severity === s.id}
            onClick={() => setFilters({ severity: s.id })}
          >
            {s.id === 'BREAKING' && <span className="dot" style={{ ['--dot' as string]: 'var(--green)' }} aria-hidden="true" />}
            {s.id === 'ALERT' && <span className="dot" style={{ ['--dot' as string]: 'var(--cyan)' }} aria-hidden="true" />}
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ───────────── feed ───────────── */

interface FeedContext {
  /** stories in the current view */
  count: number;
  /** oldest feed position the view is complete down to (COMPLETE: its whole history is loaded) */
  floor: FeedPos | null;
}

function headerOffset(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('scroll-padding-top');
  return Number.parseFloat(v) || 0;
}

/** The topmost card on screen (below the sticky header) and where it sits. */
function readAnchor(root: HTMLElement | null): Anchor | null {
  if (!root) return null;
  const under = headerOffset();
  for (const el of root.querySelectorAll<HTMLElement>('[data-article-id]')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > under && el.dataset.articleId) return { id: el.dataset.articleId, top: r.top };
  }
  return null;
}

/** Run `fn` with the element once it is in the DOM (a virtualized row renders a frame or two after a scroll). */
function withElement(id: string, fn: (el: HTMLElement) => void, frames = 12): () => void {
  let raf = 0;
  const tick = (left: number) => {
    const el = document.getElementById(id);
    if (el) fn(el);
    else if (left > 0) raf = requestAnimationFrame(() => tick(left - 1));
  };
  raf = requestAnimationFrame(() => tick(frames));
  return () => cancelAnimationFrame(raf);
}

function Feed({ wide }: { wide: boolean }) {
  const articles = useStore((s) => s.articles);
  const buffered = useStore((s) => s.buffered);
  const filters = useStore((s) => s.filters);
  const pages = useStore((s) => s.pages);
  const pinned = useStore((s) => s.pinned);
  const enter = useStore((s) => s.enter);
  const hydrated = useStore((s) => s.hydrated);
  const loadError = useStore((s) => s.loadError);
  const focus = useStore((s) => s.focus);
  const loadPage = useStore((s) => s.loadPage);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  // The view is the contiguous range this filter is known to be complete for, plus
  // stories opened directly (never another filter's older top-up, which would be a silent hole).
  const floor = useMemo(() => rangeFloor(pages, filters), [pages, filters]);
  const visible = useMemo(() => viewFrom(articles, filters, floor, pinned), [articles, filters, floor, pinned]);
  const pending = useMemo(() => buffered.filter((a) => matchesFilters(a, filters)).length, [buffered, filters]);
  const key = filterKey(filters);
  const filled = pages.filled[key] === true;

  // A narrow filter over a windowed feed: top it up from the server once. Re-runs when an
  // in-flight load settles (a fill dropped because another page was loading is retried), but
  // not after an error (that waits for the reader's Retry or a filter change).
  useEffect(() => {
    if (!hydrated || pages.loading || pages.error !== null || filled) return;
    if (visible.length < FILL_BELOW) void loadPage('fill');
  }, [hydrated, key, filled, visible.length, pages.loading, pages.error, loadPage]);

  /* ── virtualization: one-way per mount, with the reader's place carried across ── */

  const focusPending = focus !== null && focus.nonce > handledFocusNonce;
  const anchorRef = useRef<Anchor | null>(null);
  const heightRef = useRef(0);
  const [virtualize, setVirtualize] = useState(() => visible.length > VIRTUALIZE_AFTER);
  // Where the virtualized list starts: decided once, when it mounts.
  const [initialLocation, setInitialLocation] = useState<FlatIndexLocationWithAlign | undefined>(() => {
    if (!virtualize || focusPending || !memory.anchor || memory.y <= AT_TOP_PX) return undefined;
    const index = visible.findIndex((a) => a.id === memory.anchor?.id);
    return index === -1 ? undefined : { index, align: 'start', offset: -memory.anchor.top };
  });
  // Keeps the feed at its previous height until the virtualized rows are on screen.
  const [reserve, setReserve] = useState<number | null>(() => (initialLocation ? memory.height : null));

  if (!virtualize && visible.length > VIRTUALIZE_AFTER) {
    // The plain list is about to be replaced by the virtualized one (e.g. after "Load older"):
    // without this the page collapses to one card for a frame and the reader is thrown upwards.
    setVirtualize(true);
    const anchor = anchorRef.current;
    const index = anchor ? visible.findIndex((a) => a.id === anchor.id) : -1;
    if (anchor && index !== -1 && window.scrollY > AT_TOP_PX) {
      setInitialLocation({ index, align: 'start', offset: -anchor.top });
      setReserve(heightRef.current);
    }
  }

  const releaseReserve = useCallback(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => setReserve(null)));
  }, []);

  useEffect(() => {
    if (reserve === null) return;
    const t = setTimeout(() => setReserve(null), 1_000); // never hold the height for long
    return () => clearTimeout(t);
  }, [reserve]);

  const onItemsRendered = useCallback(
    (items: ListItem<NewsArticle>[]) => {
      if (reserve === null || items.length === 0) return;
      if (!initialLocation || items.some((i) => i.index === initialLocation.index)) releaseReserve();
    },
    [reserve, initialLocation, releaseReserve],
  );

  // Remember where the reader is (topmost card, scroll, feed height, card size).
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      memory.y = window.scrollY;
      const a = readAnchor(feedRef.current);
      if (a) anchorRef.current = a;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, [hydrated]);

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      heightRef.current = el.offsetHeight;
      const items = el.querySelectorAll('[data-article-id]').length;
      if (!virtualize && items > 0) memory.cardPx = Math.max(120, Math.round(el.offsetHeight / items));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hydrated, virtualize]);

  // Leaving LIVE: the DOM is still intact here, so this is the reader's real place.
  useLayoutEffect(
    () => () => {
      memory.anchor = readAnchor(feedRef.current) ?? anchorRef.current;
      memory.height = feedRef.current?.offsetHeight ?? 0;
    },
    [],
  );

  /* ── focus requests: toast "View", tape row ── */

  useEffect(() => {
    if (!focus || focus.nonce <= handledFocusNonce) return;
    const index = visible.findIndex((a) => a.id === focus.id);
    if (index === -1) return; // not in this view yet: re-checked when the view updates
    const nonce = focus.nonce;
    let cancelFocus: (() => void) | null = null;
    const raf = requestAnimationFrame(() => {
      handledFocusNonce = nonce;
      const el = document.getElementById(`card-${focus.id}`);
      if (el) el.scrollIntoView({ block: 'start' });
      else virtuoso.current?.scrollToIndex({ index, align: 'start', offset: -headerOffset() });
      cancelFocus = withElement(`card-${focus.id}-toggle`, (t) => t.focus({ preventScroll: true }));
    });
    return () => {
      cancelAnimationFrame(raf);
      cancelFocus?.();
    };
  }, [focus, visible]);

  const renderCard = useCallback(
    (_: number, a: NewsArticle) => <FeedItem article={a} enter={enter[a.id]} floor={floor} />,
    [enter, floor],
  );

  const context = useMemo<FeedContext>(() => ({ count: visible.length, floor }), [visible.length, floor]);

  if (!hydrated) {
    return loadError ? <FeedError message={loadError} /> : <FeedSkeleton />;
  }

  return (
    <div className="feed" ref={feedRef} style={reserve !== null ? { minHeight: reserve } : undefined}>
      <NewPill count={pending} />
      {visible.length === 0 ? (
        <FeedEmpty floor={floor} />
      ) : virtualize ? (
        <Virtuoso
          ref={virtuoso}
          useWindowScroll
          data={visible}
          context={context}
          computeItemKey={(_, a) => a.id}
          itemContent={renderCard}
          defaultItemHeight={memory.cardPx}
          initialTopMostItemIndex={initialLocation}
          itemsRendered={onItemsRendered}
          increaseViewportBy={{ top: 800, bottom: 1200 }}
          // Wide screens page in older stories as the reader scrolls. Below 1100px the
          // pipeline and chain panels sit under the feed: "Load older" stays the gate so
          // they remain reachable.
          endReached={wide ? () => void loadPage('older') : undefined}
          components={VIRTUOSO_COMPONENTS}
        />
      ) : (
        <>
          <ol className="feed__list">
            {visible.map((a) => (
              <li key={a.id} className="feed__item" data-article-id={a.id}>
                <OutOfRangeNote article={a} floor={floor} />
                <NewsCard article={a} enter={enter[a.id]} />
              </li>
            ))}
          </ol>
          <FeedFooter {...context} />
        </>
      )}
    </div>
  );
}

const VIRTUOSO_COMPONENTS = {
  Footer: ({ context }: { context: FeedContext }) => <FeedFooter {...context} />,
};

function FeedItem({ article: a, enter, floor }: { article: NewsArticle; enter: EnterInfo | undefined; floor: FeedPos | null }) {
  return (
    <div className="feed__item" data-article-id={a.id}>
      <OutOfRangeNote article={a} floor={floor} />
      <NewsCard article={a} enter={enter} />
    </div>
  );
}

/** A story opened directly (toast, tape) that is older than the loaded range: say so, never imply continuity. */
function OutOfRangeNote({ article, floor }: { article: NewsArticle; floor: FeedPos | null }) {
  if (floor === null || atOrAbove(article, floor)) return null;
  return <p className="feed__gap label">Opened directly · the stories around it are not loaded</p>;
}

/** Floating "↑ N new" — new stories wait here instead of shifting what the reader is looking at. */
function NewPill({ count }: { count: number }) {
  const show = count > 0;
  const label = `Show ${count} new ${count === 1 ? 'story' : 'stories'}`;
  return (
    <div className="new-pill__anchor">
      <button
        type="button"
        className="new-pill"
        data-show={show ? '' : undefined}
        tabIndex={show ? 0 : -1}
        aria-hidden={!show}
        aria-label={label}
        title={label}
        onClick={() => {
          const s = useStore.getState();
          const newest = s.buffered.find((a) => matchesFilters(a, s.filters));
          window.scrollTo({ top: 0 });
          s.flushBuffered();
          noteFlushed(count);
          // keyboard and screen-reader users land on the newest story, not on a pill that just vanished
          if (newest) withElement(`card-${newest.id}-toggle`, (el) => el.focus({ preventScroll: true }));
        }}
      >
        <IconArrowUp size={12} />
        {count} new
      </button>
    </div>
  );
}

function FeedFooter({ count, floor }: FeedContext) {
  const pages = useStore((s) => s.pages);
  const loadPage = useStore((s) => s.loadPage);
  const exhausted = isComplete(floor);
  const capped = count >= ARTICLE_CAP;

  return (
    <div className="feed__footer">
      {pages.loading ? (
        <span className="label" role="status">
          Loading older stories…
        </span>
      ) : pages.error ? (
        <span className="label">
          Could not load older stories — {pages.error}{' '}
          <button type="button" className="link" onClick={() => void loadPage('older')}>
            Retry
          </button>
        </span>
      ) : exhausted ? (
        <span className="label">End of feed</span>
      ) : capped ? (
        <span className="label">Showing the latest {ARTICLE_CAP} stories for this view</span>
      ) : (
        <button type="button" className="btn btn--sm" onClick={() => void loadPage('older')}>
          Load older
        </button>
      )}
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="feed" role="status" aria-busy="true" aria-label="Loading the live feed">
      <ol className="feed__list">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="feed__item">
            <div className="card card--skel" aria-hidden="true">
              <div className="card__skel-row">
                <span className="skel" style={{ width: 64, height: 16 }} />
                <span className="skel" style={{ width: 72, height: 14 }} />
                <span className="skel" style={{ width: 110, height: 12 }} />
                <span className="skel card__skel-meta" style={{ width: 120, height: 11 }} />
              </div>
              <span className="skel" style={{ width: '82%', height: 12 }} />
              <span className="skel" style={{ width: '46%', height: 10 }} />
              <span className="skel" style={{ width: `${64 + i * 6}%`, height: 12 }} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function FeedError({ message }: { message: string }) {
  const conn = useStore((s) => s.conn);
  const retryAt = useStore((s) => s.retryAt);
  return (
    <div className="state" role="alert">
      <span className="state__title">Engine unreachable</span>
      <p className="state__text">
        {message} The feed reconnects automatically
        {retryAt ? <RetryIn at={retryAt} /> : conn === 'offline' ? ' when your device is back online.' : '.'}
      </p>
      <button type="button" className="btn btn--sm" onClick={reconnectNow}>
        Retry now
      </button>
    </div>
  );
}

function RetryIn({ at }: { at: number }) {
  const now = useClock();
  return <> — next attempt in {at > now ? shortSince(now, at) : '0s'}.</>;
}

/**
 * Honest empty state: what the engine is doing right now, never placeholder cards.
 * "Nothing published" is only claimed when the server confirmed it (the view's whole
 * history is loaded); otherwise the reader can load further back.
 */
function FeedEmpty({ floor }: { floor: FeedPos | null }) {
  const chains = useStore((s) => s.stats?.chains ?? null);
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const pages = useStore((s) => s.pages);
  const loadPage = useStore((s) => s.loadPage);
  const now = useClock();
  const n = chains?.length ?? 0;
  const narrowed = filters.chain !== 'all' || filters.severity !== 'all';
  const complete = isComplete(floor);

  return (
    <div className="state feed-empty">
      <span className="state__title">{narrowed ? 'No matching stories' : 'Listening'}</span>
      <p className="state__text">
        {pages.loading ? (
          <span role="status">{narrowed ? 'Checking older stories for this filter… ' : 'Checking older stories… '}</span>
        ) : pages.error ? (
          `Could not check older stories — ${pages.error}. `
        ) : complete ? (
          narrowed ? 'Nothing published for this filter yet. ' : null
        ) : (
          'None in the stories loaded so far. '
        )}
        Scanning {n} chain{n === 1 ? '' : 's'}. Anomalies appear here the moment the engine detects them.
      </p>
      {chains && chains.length > 0 && (
        <ul className="feed-empty__chains">
          {chains.map((c) => (
            <li key={c.id}>
              <span className="dot" style={{ ['--dot' as string]: STATUS_COLOR[c.status] }} aria-hidden="true" />
              <span className="feed-empty__name">{c.name}</span>
              <span className="muted">{c.status}</span>
              <span className="muted mono">{c.lastScanAt ? `${shortSince(c.lastScanAt, now)} ago` : 'no scan yet'}</span>
            </li>
          ))}
        </ul>
      )}
      {(narrowed || (!complete && !pages.loading)) && (
        <div className="feed-empty__actions">
          {!complete && !pages.loading && (
            <button type="button" className="btn btn--sm" onClick={() => void loadPage('older')}>
              {pages.error ? 'Retry' : 'Load older'}
            </button>
          )}
          {narrowed && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setFilters({ chain: 'all', severity: 'all' })}>
              Show all stories
            </button>
          )}
        </div>
      )}
    </div>
  );
}
