import type { KnownChainId } from '../../../shared/types.js';
import { createAdapter, type AdapterOptions } from './adapter.js';
import { CHAIN_CONFIGS } from './configs.js';
import type { ChainAdapter } from './types.js';

/** One adapter per requested chain, in the given order (duplicates ignored). */
export function createChainAdapters(ids: KnownChainId[], opts: AdapterOptions = {}): ChainAdapter[] {
  return [...new Set(ids)].map((id) => createAdapter(CHAIN_CONFIGS[id], opts));
}
