import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, fetchText, HttpError, parseRetryAfter, registerLimiter, resetHttpState } from '../src/net/http.js';

type FetchArgs = [string, RequestInit | undefined];

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn<(...args: FetchArgs) => Promise<Response>>(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetHttpState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchJson / fetchText', () => {
  it('parses JSON and sends the HootRadar User-Agent', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ ok: 1 }));
    await expect(fetchJson('https://example.test/a', { headers: { 'x-extra': '1' } })).resolves.toEqual({ ok: 1 });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['user-agent']).toBe('HootRadar/0.1 (+crypto intelligence newsroom)');
    expect(headers['x-extra']).toBe('1');
  });

  it('returns raw text', async () => {
    stubFetch(async () => new Response('<rss/>', { status: 200 }));
    await expect(fetchText('https://example.test/feed')).resolves.toBe('<rss/>');
  });

  it('throws HttpError with status and url on 4xx without retrying', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ error: 'nope' }, 404));
    const err = await fetchJson('https://example.test/missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).url).toBe('https://example.test/missing');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid JSON with an HttpError', async () => {
    stubFetch(async () => new Response('<html>', { status: 200 }));
    await expect(fetchJson('https://example.test/html')).rejects.toBeInstanceOf(HttpError);
  });

  it('retries once on 5xx with backoff', async () => {
    const fetchMock = stubFetch(async () =>
      fetchMock.mock.calls.length === 1 ? jsonResponse({}, 503) : jsonResponse({ second: true }),
    );
    const p = fetchJson('https://example.test/flaky');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual({ second: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours retry-after seconds on 429', async () => {
    const fetchMock = stubFetch(async () =>
      fetchMock.mock.calls.length === 1 ? jsonResponse({}, 429, { 'retry-after': '3' }) : jsonResponse([1]),
    );
    const p = fetchJson('https://example.test/limited');
    await vi.advanceTimersByTimeAsync(2900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('parses retry-after as seconds or an HTTP date', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter(new Date(60_000).toUTCString(), 0)).toBe(60_000);
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });

  it('caps the retry-after wait at 10 s', async () => {
    const fetchMock = stubFetch(async () =>
      fetchMock.mock.calls.length === 1 ? jsonResponse({}, 429, { 'retry-after': '120' }) : jsonResponse({}),
    );
    const p = fetchJson('https://example.test/very-limited');
    await vi.advanceTimersByTimeAsync(9_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toEqual({});
  });

  it('gives up after one retry and reports network errors as status 0', async () => {
    const fetchMock = stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const p = fetchJson('https://example.test/down').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = await p;
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(0);
    expect((err as HttpError).message).toContain('network error');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts slow requests after timeoutMs', async () => {
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const p = fetchJson('https://example.test/slow', { timeoutMs: 1000, retries: 0 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await p;
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toContain('timeout after 1000ms');
  });
});

describe('TTL cache', () => {
  it('serves repeated and concurrent requests from one fetch until the TTL expires', async () => {
    let n = 0;
    const fetchMock = stubFetch(async () => jsonResponse({ n: ++n }));
    const url = 'https://example.test/cached';
    const [a, b] = await Promise.all([fetchJson(url, { cacheTtlMs: 5000 }), fetchJson(url, { cacheTtlMs: 5000 })]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
    await expect(fetchJson(url, { cacheTtlMs: 5000 })).resolves.toEqual({ n: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5001);
    await expect(fetchJson(url, { cacheTtlMs: 5000 })).resolves.toEqual({ n: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures or uncached requests', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({}, 400));
    await expect(fetchJson('https://example.test/bad', { cacheTtlMs: 5000 })).rejects.toBeInstanceOf(HttpError);
    await expect(fetchJson('https://example.test/bad', { cacheTtlMs: 5000 })).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('rate limiters', () => {
  it('queues FIFO, never drops, and keeps any 60 s window within perMinute', async () => {
    registerLimiter('test-bucket', { perMinute: 20 });
    const startedAt: number[] = [];
    const order: number[] = [];
    stubFetch(async (url) => {
      startedAt.push(Date.now());
      order.push(Number(new URL(url).searchParams.get('i')));
      return jsonResponse({});
    });
    const t0 = Date.now();
    const all = Promise.all(
      Array.from({ length: 25 }, (_, i) => fetchJson(`https://example.test/x?i=${i}`, { limiter: 'test-bucket' })),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(startedAt.length).toBe(2); // burst = 10% of the budget

    await vi.advanceTimersByTimeAsync(60_000);
    expect(startedAt.filter((t) => t - t0 < 60_000).length).toBeLessThanOrEqual(20);

    await vi.advanceTimersByTimeAsync(60_000);
    await all;
    expect(startedAt.length).toBe(25);
    expect(order).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('serializes requests at minIntervalMs', async () => {
    registerLimiter('test-serial', { perMinute: 600, minIntervalMs: 1000 });
    const startedAt: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    stubFetch(async () => {
      startedAt.push(Date.now());
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 1500));
      concurrent--;
      return jsonResponse({});
    });
    const all = Promise.all(
      [0, 1, 2].map((i) => fetchJson(`https://example.test/s?i=${i}`, { limiter: 'test-serial' })),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(maxConcurrent).toBe(1);
    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(1000);
    expect(startedAt[2]! - startedAt[1]!).toBeGreaterThanOrEqual(1000);
  });

  it('rejects an unknown limiter key', async () => {
    stubFetch(async () => jsonResponse({}));
    await expect(fetchJson('https://example.test/u', { limiter: 'nope' })).rejects.toThrow('unknown rate limiter');
  });

  it('pre-registers the documented provider limiters', async () => {
    stubFetch(async () => jsonResponse({}));
    for (const key of ['geckoterminal', 'dexscreener', 'dexscreener-meta', 'pumpfun', 'gdelt', 'hn', 'biz']) {
      await expect(fetchJson(`https://example.test/${key}`, { limiter: key })).resolves.toEqual({});
    }
  });
});
