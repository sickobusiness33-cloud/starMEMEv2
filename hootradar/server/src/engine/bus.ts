import { EventEmitter } from 'node:events';
import type { ChainId, DetectionEvent, NewsArticle } from '../../../shared/types.js';

/** In-process event bus. The HTTP layer subscribes to fan events out over SSE. */
export interface BusEvents {
  article: [NewsArticle];
  detection: [DetectionEvent];
  /** emitted after every discover/refresh cycle of a chain */
  scan: [{ chain: ChainId; kind: 'discover' | 'refresh'; ok: boolean; tokens: number; error: string | null; at: number }];
}

export class Bus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(1000);
  }
  on<K extends keyof BusEvents>(event: K, fn: (...args: BusEvents[K]) => void): () => void {
    this.ee.on(event, fn as (...a: unknown[]) => void);
    return () => this.ee.off(event, fn as (...a: unknown[]) => void);
  }
  emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): void {
    this.ee.emit(event, ...args);
  }
}
