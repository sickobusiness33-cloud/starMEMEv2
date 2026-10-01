import type {
  ArticleResponse,
  ChainId,
  DetectionEvent,
  FeedResponse,
  QuantLeadersResponse,
  QuantLibraryResponse,
  RadarReport,
  Severity,
  Stats,
} from '@shared/types';

/** Typed REST client for /api. Every failure becomes an ApiError with a human message. */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSec: number | null;

  constructor(status: number, code: string, message: string, retryAfterSec: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Unexpected error';
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface RequestOpts {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = 'GET', body, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const forwardAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        signal: ctrl.signal,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (timedOut) throw new ApiError(0, 'timeout', 'The HootRadar server took too long to answer.');
      throw new ApiError(0, 'network', 'Cannot reach the HootRadar server.');
    }

    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = res.status >= 500 ? 'The HootRadar server hit an error.' : `Request failed (${res.status}).`;
      try {
        const data = (await res.json()) as { error?: unknown; message?: unknown };
        if (typeof data.error === 'string') code = data.error;
        if (typeof data.message === 'string' && data.message) message = data.message;
      } catch {
        // non-JSON error body (proxy page): keep the generic message
      }
      const retry = Number(res.headers.get('retry-after'));
      throw new ApiError(res.status, code, message, Number.isFinite(retry) && retry > 0 ? retry : null);
    }

    try {
      return (await res.json()) as T;
    } catch {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new ApiError(res.status, 'bad_response', 'The server sent a response the app could not read.');
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
}

export interface FeedQuery {
  limit?: number;
  before?: number | null;
  chain?: ChainId | null;
  severity?: Severity | null;
}

export const api = {
  stats: (signal?: AbortSignal) => request<Stats>('/api/stats', { signal }),

  feed: (q: FeedQuery = {}, signal?: AbortSignal) =>
    request<FeedResponse>(`/api/feed${qs({ limit: q.limit ?? 40, before: q.before, chain: q.chain, severity: q.severity })}`, {
      signal,
    }),

  article: (id: string, signal?: AbortSignal) =>
    request<ArticleResponse>(`/api/articles/${encodeURIComponent(id)}`, { signal }),

  detections: (limit = 60, signal?: AbortSignal) =>
    request<{ events: DetectionEvent[] }>(`/api/detections${qs({ limit })}`, { signal }),

  startRadar: (query: string, chain: ChainId | null, signal?: AbortSignal) =>
    request<{ id: string }>('/api/radar', { method: 'POST', body: chain ? { query, chain } : { query }, signal }),

  radar: (id: string, signal?: AbortSignal) => request<RadarReport>(`/api/radar/${encodeURIComponent(id)}`, { signal }),

  quantLibrary: (signal?: AbortSignal) => request<QuantLibraryResponse>('/api/quant/library', { signal }),

  quantLeaders: (signal?: AbortSignal) => request<QuantLeadersResponse>('/api/quant/leaders', { signal }),
};

export const STREAM_URL = '/api/stream';
export const radarStreamUrl = (id: string) => `/api/radar/${encodeURIComponent(id)}/stream`;
