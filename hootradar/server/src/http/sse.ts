import type { ServerResponse } from 'node:http';
import type { FastifyReply } from 'fastify';

const HEARTBEAT_MS = 15_000;
/** Client reconnection delay advertised to EventSource. */
const RETRY_MS = 3_000;
/**
 * Frames that must not be lost (articles, detections, radar reports) wait here
 * while the socket is congested. A client that falls this far behind is cut
 * off; EventSource reconnects and receives a fresh `hello` snapshot. Kept small:
 * every open stream may hold this much, and a client that never reads would.
 */
const MAX_PENDING_BYTES = 256 * 1024;
/**
 * Bytes Node may already hold in the socket's write buffer (the first frames,
 * written before backpressure is known) beyond which the client is treated as
 * not reading and cut off.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** A graceful close waits this long for a congested socket to drain before giving up. */
const END_DRAIN_TIMEOUT_MS = 5_000;

export interface SendOpts {
  /** May be skipped while the socket is congested (periodic stats, heartbeats). */
  droppable?: boolean;
}

export interface SseStream {
  readonly closed: boolean;
  /** Returns false when the frame was not accepted (stream closed, or dropped under backpressure). */
  send(event: string, data: unknown, opts?: SendOpts): boolean;
  /** Same as `send` for a frame built once with `sseFrame` and fanned out to many clients. */
  sendFrame(frame: string, opts?: SendOpts): boolean;
  /** Runs once when the stream ends for any reason (client gone, close(), abort()). */
  onClose(fn: () => void): void;
  /** Ends the response after the frames already accepted have been handed to the socket. */
  close(): void;
  /** Tears the connection down immediately (shutdown, misbehaving client). */
  abort(): void;
}

const eventStreams = new WeakSet<ServerResponse>();

/** True when the reply was turned into an event stream (used to keep SSE out of request logs). */
export function isEventStream(reply: FastifyReply): boolean {
  return eventStreams.has(reply.raw);
}

/** One SSE frame. JSON.stringify never emits raw newlines, so a single `data:` line is always valid. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Takes over a Fastify reply and turns it into a Server-Sent Events stream.
 * Fastify hooks no longer run for this reply, so every header is written here.
 */
export function openSse(reply: FastifyReply): SseStream {
  reply.hijack();
  const res = reply.raw;
  eventStreams.add(res);
  res.socket?.setNoDelay?.(true);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  const stream = new ResponseStream(res);
  // Sends the headers right away so the client sees the stream open before the first event.
  stream.sendFrame(`retry: ${RETRY_MS}\n\n`);
  return stream;
}

class ResponseStream implements SseStream {
  private ended = false;
  private torn = false;
  private congested = false;
  private pending: string[] = [];
  private pendingBytes = 0;
  private endTimer: NodeJS.Timeout | null = null;
  private readonly closeHandlers: Array<() => void> = [];
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly res: ServerResponse) {
    this.heartbeat = setInterval(() => this.sendFrame(': hb\n\n', { droppable: true }), HEARTBEAT_MS);
    this.heartbeat.unref();
    // 'close' on the response fires both when the client disconnects and after a normal end.
    res.once('close', () => this.teardown());
    // kept attached: an 'error' with no listener would crash the process
    res.on('error', () => this.teardown());
  }

  get closed(): boolean {
    return this.ended || this.torn;
  }

  send(event: string, data: unknown, opts?: SendOpts): boolean {
    if (this.closed) return false;
    return this.sendFrame(sseFrame(event, data), opts);
  }

  sendFrame(frame: string, opts: SendOpts = {}): boolean {
    if (this.closed) return false;
    if (!this.congested) {
      if (this.res.writableLength > MAX_BUFFERED_BYTES) {
        this.abort();
        return false;
      }
      if (!this.res.write(frame)) this.waitForDrain();
      return true;
    }
    if (opts.droppable) return false;
    const bytes = Buffer.byteLength(frame);
    if (this.pendingBytes + bytes > MAX_PENDING_BYTES) {
      this.abort();
      return false;
    }
    this.pending.push(frame);
    this.pendingBytes += bytes;
    return true;
  }

  onClose(fn: () => void): void {
    if (this.torn) fn();
    else this.closeHandlers.push(fn);
  }

  close(): void {
    if (this.closed) return;
    this.ended = true;
    clearInterval(this.heartbeat);
    if (!this.congested) {
      this.res.end();
      return;
    }
    // Queued frames go out on 'drain' (see flush); a socket that never drains is cut off.
    this.endTimer = setTimeout(() => this.abort(), END_DRAIN_TIMEOUT_MS);
    this.endTimer.unref();
  }

  abort(): void {
    if (!this.res.destroyed) this.res.destroy();
    this.teardown();
  }

  private waitForDrain(): void {
    this.congested = true;
    this.res.once('drain', () => this.flush());
  }

  private flush(): void {
    this.congested = false;
    while (this.pending.length > 0 && !this.torn) {
      const frame = this.pending.shift() as string;
      this.pendingBytes -= Buffer.byteLength(frame);
      if (!this.res.write(frame)) {
        this.waitForDrain();
        return;
      }
    }
    if (this.ended && !this.torn) this.res.end();
  }

  private teardown(): void {
    if (this.torn) return;
    this.torn = true;
    // A client that went away can leave the socket half-open; release it unless the response completed.
    if (!this.res.writableFinished && !this.res.destroyed) this.res.destroy();
    clearInterval(this.heartbeat);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.pending = [];
    this.pendingBytes = 0;
    for (const fn of this.closeHandlers.splice(0)) {
      try {
        fn();
      } catch {
        // a cleanup callback must not prevent the others from running
      }
    }
  }
}

/** A set of live streams that receive the same frames (the newsroom feed). */
export class SseHub {
  private readonly streams = new Set<SseStream>();

  get size(): number {
    return this.streams.size;
  }

  add(stream: SseStream): void {
    if (stream.closed) return;
    this.streams.add(stream);
    stream.onClose(() => this.streams.delete(stream));
  }

  /** Serializes once and writes the same frame to every client. */
  broadcast(event: string, data: unknown, opts?: SendOpts): void {
    if (this.streams.size === 0) return;
    const frame = sseFrame(event, data);
    for (const s of this.streams) s.sendFrame(frame, opts);
  }
}
