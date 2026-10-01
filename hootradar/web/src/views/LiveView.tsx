import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { NewsArticle } from '@shared/types';
import { ARTICLE_CAP, filterKey, matchesFilters, useStore, type SeverityFilter } from '../store';
import { reconnectNow } from '../lib/stream';
import { STATUS_COLOR } from '../lib/chains';
import { useClock } from '../lib/time';
import { shortSince } from '../lib/format';
import { NewsCard } from '../components/NewsCard';
import { SignalTape } from '../components/SignalTape';
import { PipelinePanel } from '../components/PipelinePanel';
import { ChainsPanel } from '../components/ChainsPanel';
import { IconArrowUp } from '../components/Icons';

const VIRTUALIZE_AFTER = 50;
/** within this many px of the top the reader is "looking at the top of the feed" */
const AT_TOP_PX = 48;

export function LiveView() {
  useLiveAtTop();

  return (
    <div className="live">
      <div className="live__feed">
        <FeedToolbar />
        <Feed />
      </div>
      <aside className="live__rail" aria-label="Engine activity">
        <SignalTape />
        <PipelinePanel />
        <ChainsPanel />
      </aside>
    </div>
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

function Feed() {
  const articles = useStore((s) => s.articles);
  const buffered = useStore((s) => s.buffered);
  const filters = useStore((s) => s.filters);
  const enter = useStore((s) => s.enter);
  const hydrated = useStore((s) => s.hydrated);
  const loadError = useStore((s) => s.loadError);
  const focus = useStore((s) => s.focus);
  const loadPage = useStore((s) => s.loadPage);
  const virtuoso = useRef<VirtuosoHandle>(null);

  const visible = useMemo(
    () => (filters.chain === 'all' && filters.severity === 'all' ? articles : articles.filter((a) => matchesFilters(a, filters))),
    [articles, filters],
  );
  const pending = useMemo(() => buffered.filter((a) => matchesFilters(a, filters)).length, [buffered, filters]);
  const virtualize = visible.length > VIRTUALIZE_AFTER;

  // A narrow filter over a windowed feed: top it up from the server once.
  useEffect(() => {
    if (hydrated && visible.length < 20) void loadPage('fill');
  }, [hydrated, filters, visible.length, loadPage]);

  // Toast "View" / tape click: bring the requested story into view and focus it.
  useEffect(() => {
    if (!focus) return;
    const index = visible.findIndex((a) => a.id === focus.id);
    if (index === -1) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`card-${focus.id}`);
      if (el) el.scrollIntoView({ block: 'start' });
      else virtuoso.current?.scrollToIndex({ index, align: 'start', offset: -headerOffset() });
      requestAnimationFrame(() => document.getElementById(`card-${focus.id}-toggle`)?.focus({ preventScroll: true }));
    });
    return () => cancelAnimationFrame(raf);
    // re-run only for a new focus request, not for every feed update
  }, [focus?.nonce]);

  const renderCard = useCallback(
    (_: number, a: NewsArticle) => (
      <div className="feed__item">
        <NewsCard article={a} enter={enter[a.id]} />
      </div>
    ),
    [enter],
  );

  if (!hydrated) {
    return loadError ? <FeedError message={loadError} /> : <FeedSkeleton />;
  }

  return (
    <div className="feed">
      <NewPill count={pending} />
      {visible.length === 0 ? (
        <FeedEmpty filtered={articles.length > 0 || filters.chain !== 'all' || filters.severity !== 'all'} />
      ) : virtualize ? (
        <Virtuoso
          ref={virtuoso}
          useWindowScroll
          data={visible}
          computeItemKey={(_, a) => a.id}
          itemContent={renderCard}
          increaseViewportBy={{ top: 800, bottom: 1200 }}
          endReached={() => void loadPage('older')}
          components={{ Footer: FeedFooter }}
        />
      ) : (
        <>
          <ol className="feed__list">
            {visible.map((a) => (
              <li key={a.id} className="feed__item">
                <NewsCard article={a} enter={enter[a.id]} />
              </li>
            ))}
          </ol>
          <FeedFooter />
        </>
      )}
    </div>
  );
}

function headerOffset(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('scroll-padding-top');
  return Number.parseFloat(v) || 0;
}

/** Floating "↑ N new" — new stories wait here instead of shifting what the reader is looking at. */
function NewPill({ count }: { count: number }) {
  const show = count > 0;
  return (
    <div className="new-pill__anchor">
      <button
        type="button"
        className="new-pill"
        data-show={show ? '' : undefined}
        tabIndex={show ? 0 : -1}
        aria-hidden={!show}
        onClick={() => {
          window.scrollTo({ top: 0 });
          useStore.getState().flushBuffered();
        }}
      >
        <IconArrowUp size={12} />
        {count} new
      </button>
    </div>
  );
}

function FeedFooter() {
  const pages = useStore((s) => s.pages);
  const filters = useStore((s) => s.filters);
  const total = useStore((s) => s.articles.length);
  const loadPage = useStore((s) => s.loadPage);
  const exhausted = pages.exhausted[filterKey(filters)] === true;
  const capped = total >= ARTICLE_CAP;

  return (
    <div className="feed__footer">
      {pages.loading ? (
        <span className="label">Loading older stories…</span>
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
        <span className="label">Showing the latest {ARTICLE_CAP} stories</span>
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
    <div className="feed" aria-busy="true" aria-label="Loading the live feed">
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

/** Honest empty state: what the engine is doing right now, never placeholder cards. */
function FeedEmpty({ filtered }: { filtered: boolean }) {
  const chains = useStore((s) => s.stats?.chains ?? null);
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const pages = useStore((s) => s.pages);
  const now = useClock();
  const n = chains?.length ?? 0;
  const narrowed = filters.chain !== 'all' || filters.severity !== 'all';

  return (
    <div className="state feed-empty">
      <span className="state__title">{narrowed && filtered ? 'No matching stories' : 'Listening'}</span>
      <p className="state__text">
        {narrowed && filtered
          ? pages.loading
            ? 'Checking older stories for this filter…'
            : 'Nothing published for this filter yet. '
          : null}
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
      {narrowed && (
        <button type="button" className="btn btn--sm" onClick={() => setFilters({ chain: 'all', severity: 'all' })}>
          Show all stories
        </button>
      )}
    </div>
  );
}
