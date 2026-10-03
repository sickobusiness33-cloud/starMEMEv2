import type { KnownChainId } from '../../../shared/types.js';
import type { ChainConfig } from './types.js';

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export const CHAIN_CONFIGS: Record<KnownChainId, ChainConfig> = {
  solana: {
    id: 'solana',
    name: 'Solana',
    short: 'SOL',
    nativeSymbol: 'SOL',
    color: '#b18cff',
    geckoNetwork: 'solana',
    dexscreenerChainId: 'solana',
    explorerTokenUrl: (address) => `https://solscan.io/token/${address}`,
    addressPattern: SOLANA_ADDRESS,
    caseInsensitiveAddress: false,
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    short: 'ETH',
    nativeSymbol: 'ETH',
    color: '#8ea2ff',
    geckoNetwork: 'eth',
    dexscreenerChainId: 'ethereum',
    explorerTokenUrl: (address) => `https://etherscan.io/token/${address}`,
    addressPattern: EVM_ADDRESS,
    caseInsensitiveAddress: true,
  },
  base: {
    id: 'base',
    name: 'Base',
    short: 'BASE',
    nativeSymbol: 'ETH',
    color: '#3d7bff',
    geckoNetwork: 'base',
    dexscreenerChainId: 'base',
    explorerTokenUrl: (address) => `https://basescan.org/token/${address}`,
    addressPattern: EVM_ADDRESS,
    caseInsensitiveAddress: true,
  },
  bsc: {
    id: 'bsc',
    name: 'BNB Chain',
    short: 'BSC',
    nativeSymbol: 'BNB',
    color: '#f3c344',
    geckoNetwork: 'bsc',
    dexscreenerChainId: 'bsc',
    explorerTokenUrl: (address) => `https://bscscan.com/token/${address}`,
    addressPattern: EVM_ADDRESS,
    caseInsensitiveAddress: true,
  },
};
