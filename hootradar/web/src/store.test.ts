import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainId, FeedResponse, NewsArticle, Severity, Stats } from '@shared/types';
import { ARTICLE_CAP, PAGE, parseCursor, useStore, viewOf } from './store';

/**
 * Feed paging against a fake /api/feed that follows the server's contract
 * (server/src/db/db.ts listArticles + /api/feed): ORDER BY createdAt DESC, id DESC;
 * `before` is a plain createdAt (strictly older) or "<createdAt>:<id>" (strictly
 * below that story in feed order); nextCursor names the page's last story.
 */

type Row = Pick<NewsArticle, 'id' | 'createdAt' | 'chain' | 'severity'>;

const byFeedOrder = (a: Row, b: Row) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function row(i: number, createdAt: number, chain: ChainId = 'solana', severity: Severity = 'ALERT'): NewsArticle {
  // ids deliberately not in createdAt order, so millisecond ties are ordered by id only
  const id = `${((i * 7919) % 1000).toString().padStart(3, '0')}-${i}`;
  return { id, createdAt, chain, severity } as Row as NewsArticle;
}

const initial = useStore.getState();
let server: NewsArticle[] = [];
let befores: Array<string | null> = [];

function feed(url: URL): FeedResponse {
  const limit = Number(url.searchParams.get('limit') ?? 40);
  const before = url.searchParams.get('before');
  befores.push(before);
  const chain = url.searchParams.get('chain');
  const severity = url.searchParams.get('severity');
  let ts: number | null = null;
  let id: string | null = null;
  if (before !== null) {
    if (/^\d+$/.test(before)) ts = Number(before);
    else {
      const c = parseCursor(before);
      if (!c) throw new Error(`bad cursor ${before}`);
      ts = c.ts;
      id = c.id;
    }
  }
  const rows = [...server]
    .sort(byFeedOrder)
    .filter((a) => ts === null || a.createdAt < ts || (id !== null && a.createdAt === ts && a.id < id))
    .filter((a) => !chain || a.chain === chain)
    .filter((a) => !severity || a.severity === severity)
    .slice(0, limit);
  const last = rows.at(-1);
  const more = rows.length === limit && last !== undefined;
  return {
    articles: rows,
    nextBefore: more ? last.createdAt : null,
    nextCursor: more ? `${last.createdAt}:${last.id}` : null,
  };
}

function hello(n = PAGE) {
  return useStore.getState().hello({ stats: {} as Stats, articles: [...server].sort(byFeedOrder).slice(0, n), events: [] });
}

async function loadAllOlder(max = 50) {
  for (let i = 0; i < max; i++) {
    const before = useStore.getState().articles.length;
    await useStore.getState().loadPage('older');
    const s = useStore.getState();
    if (s.pages.error) throw new Error(s.pages.error);
    if (s.articles.length === before) break;
  }
}

const ids = (list: Row[]) => list.map((a) => a.id);

beforeEach(() => {
  useStore.setState(initial, true);
  server = [];
  befores = [];
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input, 'http://hootradar.test');
    if (url.pathname !== '/api/feed') return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(feed(url)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('feed paging with the exact cursor', () => {
  it('sends the previous page cursor as `before` and loses no story that shares a millisecond', async () => {
    // 130 stories in groups of 9 sharing one millisecond: page boundaries fall inside groups
    server = Array.from({ length: 130 }, (_, i) => row(i, 1_000_000 + Math.floor(i / 9)));
    hello();
    await loadAllOlder();
    const s = useStore.getState();
    expect(ids(viewOf(s))).toEqual(ids([...server].sort(byFeedOrder)));
    expect(new Set(ids(s.articles)).size).toBe(130);
    // every page after the snapshot continues from "<createdAt>:<id>", never from a bare timestamp
    expect(befores.length).toBeGreaterThan(1);
    for (const b of befores) expect(b).toMatch(/^\d+:[\w-]+$/);
    expect(s.pages.exhausted['all|all']).toBe(true);
  });

  it('moves past a page that sits entirely inside one millisecond', async () => {
    server = Array.from({ length: 2 * PAGE + 5 }, (_, i) => row(i, 5_000));
    hello();
    await loadAllOlder();
    expect(ids(viewOf(useStore.getState()))).toEqual(ids([...server].sort(byFeedOrder)));
  });

  it('a narrow filter top-up does not show up in ALL as a hole', async () => {
    server = [
      ...Array.from({ length: 60 }, (_, i) => row(i, 10_000 + i * 10, 'solana')),
      ...Array.from({ length: 30 }, (_, i) => row(100 + i, 9_000 + i * 10, 'bsc')),
    ];
    hello();
    useStore.getState().setFilters({ chain: 'bsc' });
    await useStore.getState().loadPage('fill');
    let s = useStore.getState();
    expect(ids(viewOf(s))).toEqual(ids(server.filter((a) => a.chain === 'bsc').sort(byFeedOrder)));
    useStore.getState().setFilters({ chain: 'all' });
    s = useStore.getState();
    // ALL still shows exactly the server's newest PAGE (the bsc stories are older than its floor)
    expect(ids(viewOf(s))).toEqual(ids([...server].sort(byFeedOrder).slice(0, PAGE)));
    await useStore.getState().loadPage('older');
    s = useStore.getState();
    expect(ids(viewOf(s))).toEqual(ids([...server].sort(byFeedOrder).slice(0, 2 * PAGE)));
  });

  it('stops at the view cap and keeps the view contiguous after eviction', async () => {
    server = Array.from({ length: ARTICLE_CAP + 3 * PAGE }, (_, i) => row(i, 50_000 + Math.floor(i / 3)));
    hello();
    await loadAllOlder();
    const s = useStore.getState();
    const view = viewOf(s);
    expect(view.length).toBeLessThanOrEqual(ARTICLE_CAP + PAGE);
    expect(ids(view)).toEqual(ids([...server].sort(byFeedOrder).slice(0, view.length)));
    expect(s.articles.length).toBeLessThanOrEqual(ARTICLE_CAP + PAGE);
  });

  it('after a reconnect gap the view restarts at the snapshot and older pages re-fetch the gap', async () => {
    server = Array.from({ length: PAGE }, (_, i) => row(i, 1_000 + i));
    hello();
    // while disconnected, more than a snapshot's worth of stories was published
    const missed = Array.from({ length: 2 * PAGE }, (_, i) => row(500 + i, 2_000 + Math.floor(i / 4)));
    server = server.concat(missed);
    hello();
    useStore.getState().setLiveAtTop(true);
    let s = useStore.getState();
    const newest = [...server].sort(byFeedOrder);
    expect(ids(viewOf(s))).toEqual(ids(newest.slice(0, PAGE)));
    befores = [];
    await useStore.getState().loadPage('older');
    s = useStore.getState();
    const snapshotOldest = newest[PAGE - 1]!;
    expect(befores).toEqual([`${snapshotOldest.createdAt}:${snapshotOldest.id}`]);
    expect(ids(viewOf(s))).toEqual(ids(newest.slice(0, 2 * PAGE)));
  });

  it('parseCursor reads the server cursor and rejects malformed values', () => {
    expect(parseCursor('1791058210089:3f1c2a9e-0000-4000-8000-000000000000')).toEqual({
      ts: 1791058210089,
      id: '3f1c2a9e-0000-4000-8000-000000000000',
    });
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor('1791058210089')).toBeNull();
    expect(parseCursor('abc:1')).toBeNull();
    expect(parseCursor('12:')).toBeNull();
  });
});
