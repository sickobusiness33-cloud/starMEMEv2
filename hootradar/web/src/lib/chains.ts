import { useMemo } from 'react';
import type { ChainId, ChainInfo, ChainStatus } from '@shared/types';
import { useStore } from '../store';

/**
 * Presentation metadata for chains. The live list (status, last scan, colors)
 * comes from Stats.chains; these fallbacks only name a chain before stats
 * arrive or when an article references a chain the server no longer reports.
 */
export interface ChainMeta {
  id: ChainId;
  name: string;
  short: string;
  color: string;
}

const KNOWN: Record<string, Omit<ChainMeta, 'id'>> = {
  solana: { name: 'Solana', short: 'SOL', color: '#b18cff' },
  ethereum: { name: 'Ethereum', short: 'ETH', color: '#8ea2ff' },
  base: { name: 'Base', short: 'BASE', color: '#3d7bff' },
  bsc: { name: 'BNB Chain', short: 'BNB', color: '#f3c344' },
};

const EXPLORER: Record<string, string> = {
  solana: 'https://solscan.io/token/',
  ethereum: 'https://etherscan.io/token/',
  base: 'https://basescan.org/token/',
  bsc: 'https://bscscan.com/token/',
};

export function fallbackMeta(id: ChainId): ChainMeta {
  const k = KNOWN[id];
  return k ? { id, ...k } : { id, name: id, short: id.slice(0, 4).toUpperCase(), color: '#66717b' };
}

export function metaFrom(info: ChainInfo): ChainMeta {
  return { id: info.id, name: info.name, short: info.short, color: info.color };
}

/** Lookup function that prefers server-provided chain info. */
export function useChainLookup(): (id: ChainId) => ChainMeta {
  const chains = useStore((s) => s.stats?.chains);
  return useMemo(() => {
    const map = new Map<string, ChainMeta>();
    for (const c of chains ?? []) map.set(c.id, metaFrom(c));
    return (id: ChainId) => map.get(id) ?? fallbackMeta(id);
  }, [chains]);
}

export function getChainMeta(id: ChainId): ChainMeta {
  const info = useStore.getState().stats?.chains.find((c) => c.id === id);
  return info ? metaFrom(info) : fallbackMeta(id);
}

export function explorerUrl(chain: ChainId, address: string): string | null {
  const base = EXPLORER[chain];
  return base ? `${base}${address}` : null;
}

export function dexscreenerUrl(chain: ChainId, pairOrToken: string): string {
  return `https://dexscreener.com/${encodeURIComponent(chain)}/${encodeURIComponent(pairOrToken)}`;
}

export const STATUS_COLOR: Record<ChainStatus, string> = {
  scanning: 'var(--green)',
  degraded: 'var(--amber)',
  down: 'var(--red)',
  idle: 'var(--text-3)',
};
