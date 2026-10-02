import type { StreamEvent } from '@shared/types';
import { useStore } from '../store';
import { api, errorMessage, STREAM_URL } from './api';
import { notifyBreaking } from './notify';

/**
 * The app's single connection to /api/stream.
 *
 * - One EventSource for the whole app; events are dispatched into the store.
 * - Reconnects are ours, not the browser's: on any error the source is closed
 *   and reopened with capped exponential backoff + jitter, so a server that
 *   answers 5xx (which makes EventSource give up) is retried too.
 * - Watchdog: stats arrive every 5 s; 30 s of silence means a dead socket.
 * - `online` / `visibilitychange` reconnect immediately (phones drop
 *   background sockets).
 * - If `hello` has not arrived after 4 s, a REST snapshot fills the screen so
 *   the reader is never stuck on skeletons while the stream negotiates.
 */

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const STALE_MS = 30_000;
const WATCHDOG_EVERY_MS = 5_000;
const REST_FALLBACK_MS = 4_000;
const REST_RETRY_MS = 15_000;

type Timer = ReturnType<typeof setTimeout>;

let source: EventSource | null = null;
let attempt = 0;
let lastEventAt = 0;
let started = false;
let retryTimer: Timer | null = null;
let restTimer: Timer | null = null;
/** one REST snapshot at a time: a manual retry must not start a second, parallel retry chain */
let restInFlight = false;
let watchdog: ReturnType<typeof setInterval> | null = null;

const store = () => useStore.getState();

export function startStream(): void {
  if (started) return;
  started = true;
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisibility);
  watchdog = setInterval(checkStale, WATCHDOG_EVERY_MS);
  connect();
  restTimer = setTimeout(restSnapshot, REST_FALLBACK_MS);
}

export function stopStream(): void {
  if (!started) return;
  started = false;
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOffline);
  document.removeEventListener('visibilitychange', onVisibility);
  if (watchdog) clearInterval(watchdog);
  clearRestTimer();
  clearRetry();
  closeSource();
}

/** Reconnect now (manual retry button). */
export function reconnectNow(): void {
  attempt = 0;
  connect();
  if (!store().hydrated) void restSnapshot();
}

function clearRestTimer(): void {
  if (restTimer) clearTimeout(restTimer);
  restTimer = null;
}

function connect(): void {
  clearRetry();
  closeSource();
  if (!navigator.onLine) {
    store().setConn('offline');
    return;
  }
  store().setConn(store().hydrated ? 'reconnecting' : 'connecting');

  const es = new EventSource(STREAM_URL);
  source = es;
  lastEventAt = Date.now();

  const handle = (ev: Event) => {
    if (source !== es) return;
    lastEventAt = Date.now();
    let event: StreamEvent;
    try {
      event = JSON.parse((ev as MessageEvent<string>).data) as StreamEvent;
    } catch {
      return; // a malformed frame must not take the feed down
    }
    if (!event || typeof event !== 'object') return;
    dispatch(event);
  };

  es.addEventListener('hello', handle);
  es.addEventListener('article', handle);
  es.addEventListener('detection', handle);
  es.addEventListener('stats', handle);
  es.onerror = () => {
    if (source === es) scheduleReconnect();
  };
}

function dispatch(event: StreamEvent): void {
  const s = store();
  switch (event.type) {
    case 'hello':
      attempt = 0;
      clearRestTimer();
      s.hello(event);
      s.setLoadError(null);
      s.setConn('open');
      break;
    case 'article': {
      const result = s.ingestArticle(event.article);
      const watchingTop = store().liveAtTop && document.visibilityState === 'visible';
      if (result !== 'duplicate' && event.article.severity === 'BREAKING' && !watchingTop) notifyBreaking(event.article);
      break;
    }
    case 'detection':
      s.ingestDetection(event.event);
      break;
    case 'stats':
      s.setStats(event.stats);
      if (s.conn !== 'open') s.setConn('open');
      break;
  }
}

function scheduleReconnect(): void {
  closeSource();
  clearRetry();
  if (!navigator.onLine) {
    store().setConn('offline');
    return;
  }
  const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const delay = Math.round(cap / 2 + (Math.random() * cap) / 2);
  attempt = Math.min(attempt + 1, 8);
  store().setConn(store().hydrated ? 'reconnecting' : 'connecting', Date.now() + delay);
  retryTimer = setTimeout(connect, delay);
}

function checkStale(): void {
  if (!source) return;
  if (Date.now() - lastEventAt > STALE_MS) {
    attempt = 0;
    connect();
  }
}

function onOnline(): void {
  attempt = 0;
  connect();
}

function onOffline(): void {
  clearRetry();
  closeSource();
  store().setConn('offline');
}

function onVisibility(): void {
  if (document.visibilityState !== 'visible') return;
  const dead = !source || source.readyState === EventSource.CLOSED || Date.now() - lastEventAt > STALE_MS;
  if (dead || retryTimer) {
    attempt = 0;
    connect();
  }
}

async function restSnapshot(): Promise<void> {
  // A pending scheduled retry is superseded by this attempt (manual "Retry now" included):
  // clear it rather than orphan it, so there is only ever one retry chain.
  clearRestTimer();
  if (store().hydrated || restInFlight) return;
  restInFlight = true;
  try {
    const [stats, feed, det] = await Promise.all([api.stats(), api.feed({ limit: 40 }), api.detections(60)]);
    if (!store().hydrated) store().hello({ stats, articles: feed.articles, events: det.events });
    store().setLoadError(null);
  } catch (e) {
    if (store().hydrated || !started) return;
    store().setLoadError(errorMessage(e));
    clearRestTimer();
    restTimer = setTimeout(() => void restSnapshot(), REST_RETRY_MS);
  } finally {
    restInFlight = false;
  }
}

function clearRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function closeSource(): void {
  if (!source) return;
  source.onerror = null;
  source.close();
  source = null;
}
