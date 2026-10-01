import type { ChainId, TokenSnapshot } from '../../../shared/types.js';

export interface ChainConfig {
  id: ChainId;
  name: string;
  short: string;
  nativeSymbol: string;
  /** UI accent for the chain dot */
  color: string;
  /** GeckoTerminal network id: solana | eth | base | bsc */
  geckoNetwork: string;
  /** DexScreener chainId: solana | ethereum | base | bsc */
  dexscreenerChainId: string;
  explorerTokenUrl: (address: string) => string;
  addressPattern: RegExp;
  /** EVM addresses are case-insensitive; Solana base58 is not */
  caseInsensitiveAddress: boolean;
}

export type TokenEnrichment = Pick<TokenSnapshot, 'holders' | 'top10HolderPct' | 'security'> &
  Partial<Pick<TokenSnapshot, 'imageUrl' | 'links'>>;

/**
 * One adapter per blockchain. Adding a chain = adding a ChainConfig (+ optional
 * chain-specific discovery source) and registering it in chains/registry.ts.
 */
export interface ChainAdapter {
  readonly config: ChainConfig;
  /**
   * Newest tokens on this chain (newest first), as merged snapshots.
   * Partial provider failure is tolerated; throws only when every discovery source failed.
   */
  discover(): Promise<TokenSnapshot[]>;
  /** Batch market-data refresh for already-known tokens. Missing tokens are simply absent from the result. */
  refresh(addresses: string[]): Promise<TokenSnapshot[]>;
  /** Holders, holder concentration and security flags. Rate-limited provider: call sparingly. */
  enrich(address: string): Promise<TokenEnrichment | null>;
  /** Full lookup of one token by address (Radar). */
  lookup(address: string): Promise<TokenSnapshot | null>;
  isAddress(query: string): boolean;
  /** canonical key form of an address (lowercase for EVM) */
  normalizeAddress(address: string): string;
}
