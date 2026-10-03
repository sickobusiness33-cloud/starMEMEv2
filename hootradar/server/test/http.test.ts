import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchJson,
  fetchText,
  HttpError,
  laneLimiter,
  limiterQueueLength,
  parseRetryAfter,
  registerLimiter,
  RequestCancelledError,
  RequestQueueError,
  resetHttpState,
} from '../src/net/http.js';

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
  it('queues FIFO and keeps any 60 s window within perMinute', async () => {
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
      Array.from({ length: 25 }, (_, i) =>
        fetchJson(`https://example.test/x?i=${i}`, { limiter: 'test-bucket', maxQueueMs: 180_000 }),
      ),
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

  it('a configured burst starts at once and still keeps any 60 s window within perMinute', async () => {
    registerLimiter('test-burst', { perMinute: 6, burst: 3 });
    const startedAt: number[] = [];
    stubFetch(async () => {
      startedAt.push(Date.now());
      return jsonResponse({});
    });
    const t0 = Date.now();
    const all = Promise.all(
      Array.from({ length: 9 }, (_, i) => fetchJson(`https://example.test/b?i=${i}`, { limiter: 'test-burst', maxQueueMs: 180_000 })),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(startedAt.length).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startedAt.filter((t) => t - t0 < 60_000).length).toBeLessThanOrEqual(6);
    await vi.advanceTimersByTimeAsync(120_000);
    await all;
    expect(startedAt.length).toBe(9);
    for (let i = 0; i < startedAt.length; i++) {
      const windowStarts = startedAt.filter((t) => t >= startedAt[i]! && t - startedAt[i]! < 60_000).length;
      expect(windowStarts).toBeLessThanOrEqual(6);
    }
  });

  it("one Radar search's two GeckoTerminal calls start together in the radar lane", async () => {
    const startedAt: number[] = [];
    stubFetch(async () => {
      startedAt.push(Date.now());
      return jsonResponse({});
    });
    const limiter = laneLimiter('geckoterminal', 'radar');
    const both = Promise.allSettled([
      fetchJson('https://example.test/pools', { limiter, maxQueueMs: 10_000 }),
      fetchJson('https://example.test/info', { limiter, maxQueueMs: 10_000 }),
    ]);
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await both).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(startedAt.length).toBe(2);
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

  it('pauses the whole limiter after a 429 instead of letting queued requests hit the provider', async () => {
    registerLimiter('test-429', { perMinute: 600 });
    const startedAt: Array<[string, number]> = [];
    stubFetch(async (url) => {
      const path = new URL(url).pathname;
      startedAt.push([path, Date.now()]);
      return path === '/first' && startedAt.length === 1 ? jsonResponse({}, 429) : jsonResponse({ path });
    });
    const t0 = Date.now();
    const first = fetchJson('https://example.test/first', { limiter: 'test-429' });
    await vi.advanceTimersByTimeAsync(0);
    const second = fetchJson('https://example.test/second', { limiter: 'test-429', retries: 0 });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(startedAt.map(([p]) => p)).toEqual(['/first']); // no retry and no queued request inside the pause

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(Promise.all([first, second])).resolves.toEqual([{ path: '/first' }, { path: '/second' }]);
    expect(startedAt.slice(1).every(([, at]) => at - t0 >= 20_000)).toBe(true);
  });

  it('never pauses for less than 15 s, even when the provider says retry-after: 0', async () => {
    registerLimiter('test-429c', { perMinute: 600 });
    const calls: number[] = [];
    stubFetch(async () => {
      calls.push(Date.now());
      return calls.length === 1 ? jsonResponse({}, 429, { 'retry-after': '0' }) : jsonResponse({});
    });
    const t0 = Date.now();
    const p = fetchJson('https://example.test/zero', { limiter: 'test-429c' });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toEqual({});
    expect(calls[1]! - t0).toBeGreaterThanOrEqual(15_000);
  });

  it('doubles the pause on consecutive 429s and resets after a success', async () => {
    registerLimiter('test-429d', { perMinute: 600 });
    let status = 429;
    const calls: number[] = [];
    stubFetch(async () => {
      calls.push(Date.now());
      return jsonResponse({}, status);
    });
    const t0 = Date.now();
    const first = fetchJson('https://example.test/a', { limiter: 'test-429d', retries: 0 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toBeInstanceOf(HttpError);
    const second = fetchJson('https://example.test/b', { limiter: 'test-429d', retries: 0 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000); // first pause: 20 s
    expect(await second).toBeInstanceOf(HttpError);
    expect(calls[1]! - t0).toBeGreaterThanOrEqual(20_000);
    status = 200;
    const third = fetchJson('https://example.test/c', { limiter: 'test-429d', retries: 0 });
    await vi.advanceTimersByTimeAsync(39_000);
    expect(calls).toHaveLength(2); // second pause: 40 s
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(third).resolves.toEqual({});
    status = 429;
    const fourth = fetchJson('https://example.test/d', { limiter: 'test-429d', retries: 0 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await fourth;
    const tFourth = calls.at(-1)!;
    status = 200;
    const fifth = fetchJson('https://example.test/e', { limiter: 'test-429d', retries: 0 });
    await vi.advanceTimersByTimeAsync(21_000); // the success reset the streak: back to 20 s
    await expect(fifth).resolves.toEqual({});
    expect(calls.at(-1)! - tFourth).toBeGreaterThanOrEqual(20_000);
    expect(calls.at(-1)! - tFourth).toBeLessThan(21_000);
  });

  it('fails fast while paused when the caller cannot wait', async () => {
    registerLimiter('test-429e', { perMinute: 600 });
    const fetchMock = stubFetch(async () => (fetchMock.mock.calls.length === 1 ? jsonResponse({}, 429) : jsonResponse({})));
    await expect(fetchJson('https://example.test/x', { limiter: 'test-429e', retries: 0 })).rejects.toBeInstanceOf(HttpError);
    const err = await fetchJson('https://example.test/y', { limiter: 'test-429e', retries: 0, maxPauseWaitMs: 0 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).message).toMatch(/^rate limited by example\.test, retrying in 20s$/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never reached the provider
  });

  it('honours a retry-after longer than the retry cap for the limiter pause', async () => {
    registerLimiter('test-429b', { perMinute: 600 });
    const calls: number[] = [];
    stubFetch(async () => {
      calls.push(Date.now());
      return calls.length === 1 ? jsonResponse({}, 429, { 'retry-after': '45' }) : jsonResponse({});
    });
    const t0 = Date.now();
    const p = fetchJson('https://example.test/later', { limiter: 'test-429b' });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toEqual({});
    expect(calls[1]! - t0).toBeGreaterThanOrEqual(45_000);
  });

  it('rejects an unknown limiter key', async () => {
    stubFetch(async () => jsonResponse({}));
    await expect(fetchJson('https://example.test/u', { limiter: 'nope' })).rejects.toThrow('unknown rate limiter');
  });

  it('pre-registers the documented provider limiters', async () => {
    stubFetch(async () => jsonResponse({}));
    const keys = ['geckoterminal', 'geckoterminal-radar', 'dexscreener', 'dexscreener-radar', 'dexscreener-meta', 'pumpfun', 'gdelt', 'hn', 'biz'];
    for (const key of keys) {
      await expect(fetchJson(`https://example.test/${key}`, { limiter: key })).resolves.toEqual({});
    }
  });
});

describe('queue deadlines and cancellation', () => {
  it('bounds the time spent waiting for a limiter slot (the request timeout alone did not)', async () => {
    // live regression: a request with timeoutMs=500 on a 1/min limiter was still pending after 3 s
    registerLimiter('test-slow', { perMinute: 1 });
    const fetchMock = stubFetch(async () => jsonResponse({}));
    await expect(fetchJson('https://example.test/a', { limiter: 'test-slow' })).resolves.toEqual({});
    const queued = fetchJson('https://example.test/b', { limiter: 'test-slow', timeoutMs: 500, maxQueueMs: 1_000, retries: 0 }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(1_001);
    const err = await queued;
    expect(err).toBeInstanceOf(RequestQueueError);
    expect((err as RequestQueueError).message).toBe('example.test request queue wait timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1); // the provider was never asked
    expect(limiterQueueLength('test-slow')).toBe(0);
  });

  it('applies a default queue deadline', async () => {
    registerLimiter('test-default-wait', { perMinute: 1 });
    stubFetch(async () => jsonResponse({}));
    await fetchJson('https://example.test/a', { limiter: 'test-default-wait' });
    const queued = fetchJson('https://example.test/b', { limiter: 'test-default-wait', retries: 0 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await queued).toBeInstanceOf(RequestQueueError);
  });

  it('an aborted caller leaves the queue at once and never costs a provider call', async () => {
    registerLimiter('test-abort', { perMinute: 1 });
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(new URL(url).pathname);
      return jsonResponse({});
    });
    await fetchJson('https://example.test/first', { limiter: 'test-abort' });
    const controller = new AbortController();
    const abandoned = fetchJson('https://example.test/abandoned', { limiter: 'test-abort', signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    const next = fetchJson('https://example.test/next', { limiter: 'test-abort', maxQueueMs: 120_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(limiterQueueLength('test-abort')).toBe(2);
    controller.abort();
    expect(await abandoned).toBeInstanceOf(RequestCancelledError);
    expect(limiterQueueLength('test-abort')).toBe(1);
    await vi.advanceTimersByTimeAsync(70_000);
    await expect(next).resolves.toEqual({});
    expect(calls).toEqual(['/first', '/next']);
  });

  it('aborts a request in flight and does not retry it', async () => {
    const fetchMock = stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const controller = new AbortController();
    const p = fetchJson('https://example.test/slow', { signal: controller.signal, timeoutMs: 60_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await p).toBeInstanceOf(RequestCancelledError);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses at once when the queue is full', async () => {
    registerLimiter('test-full', { perMinute: 1, maxQueue: 1 });
    const fetchMock = stubFetch(async () => jsonResponse({}));
    await fetchJson('https://example.test/a', { limiter: 'test-full' });
    const waiting = fetchJson('https://example.test/b', { limiter: 'test-full', maxQueueMs: 120_000 });
    const err = await fetchJson('https://example.test/c', { limiter: 'test-full' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestQueueError);
    expect((err as RequestQueueError).reason).toBe('full');
    await vi.advanceTimersByTimeAsync(70_000);
    await expect(waiting).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a shared cached request survives one of its callers giving up', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchMock = stubFetch(() => new Promise<Response>((r) => (resolveFetch = r)));
    const controller = new AbortController();
    const quitter = fetchJson('https://example.test/shared', { cacheTtlMs: 10_000, signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    const stayer = fetchJson('https://example.test/shared', { cacheTtlMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await quitter).toBeInstanceOf(RequestCancelledError);
    resolveFetch(jsonResponse({ v: 1 }));
    await expect(stayer).resolves.toEqual({ v: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels a shared request once every caller gave up', async () => {
    let aborted = false;
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    const a = new AbortController();
    const b = new AbortController();
    const pa = fetchJson('https://example.test/s2', { cacheTtlMs: 10_000, signal: a.signal }).catch((e: unknown) => e);
    const pb = fetchJson('https://example.test/s2', { cacheTtlMs: 10_000, signal: b.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    a.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toBe(false);
    b.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toBe(true);
    expect(await pa).toBeInstanceOf(RequestCancelledError);
    expect(await pb).toBeInstanceOf(RequestCancelledError);
  });

  it('remembers a 404 when asked to', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({}, 404));
    for (let i = 0; i < 3; i++) {
      const err = await fetchJson('https://example.test/unknown-token', { notFoundTtlMs: 60_000 }).catch((e: unknown) => e);
      expect((err as HttpError).status).toBe(404);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await fetchJson('https://example.test/unknown-token', { notFoundTtlMs: 60_000 }).catch(() => null);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 429 on the Radar lane pauses the scanner lane of the same provider too', async () => {
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(new URL(url).pathname);
      return calls.length === 1 ? jsonResponse({}, 429) : jsonResponse({});
    });
    expect(laneLimiter('geckoterminal', 'radar')).toBe('geckoterminal-radar');
    expect(laneLimiter('geckoterminal', undefined)).toBe('geckoterminal');
    await fetchJson('https://example.test/radar', { limiter: 'geckoterminal-radar', retries: 0 }).catch(() => null);
    const scan = fetchJson('https://example.test/scan', { limiter: 'geckoterminal' });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(calls).toEqual(['/radar']);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(scan).resolves.toEqual({});
  });
});
