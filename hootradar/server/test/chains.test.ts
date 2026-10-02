import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenSnapshot } from '../../shared/types.js';
import { createAdapter } from '../src/chains/adapter.js';
import { CHAIN_CONFIGS } from '../src/chains/configs.js';
import { createChainAdapters } from '../src/chains/registry.js';
import {
  dsLatestListings,
  dsTokens,
  parseDsListings,
  parseDsPairs,
  type DsListing,
} from '../src/sources/dexscreener.js';
import {
  gtNewPools,
  gtTokenInfo,
  gtTokenTopPool,
  parseGtPools,
  parseGtTokenInfo,
  parseGtTokenPools,
} from '../src/sources/geckoterminal.js';
import { emptySnapshot } from '../src/sources/merge.js';
import { parsePumpCoins, pumpNewest } from '../src/sources/pumpfun.js';

vi.mock('../src/sources/geckoterminal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/geckoterminal.js')>()),
  gtNewPools: vi.fn(),
  gtTokenInfo: vi.fn(),
  gtTokenTopPool: vi.fn(),
}));
vi.mock('../src/sources/dexscreener.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/dexscreener.js')>()),
  dsTokens: vi.fn(),
  dsLatestListings: vi.fn(),
}));
vi.mock('../src/sources/pumpfun.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/pumpfun.js')>()),
  pumpNewest: vi.fn(),
}));

const gtNewPoolsMock = vi.mocked(gtNewPools);
const gtTokenInfoMock = vi.mocked(gtTokenInfo);
const gtTokenTopPoolMock = vi.mocked(gtTokenTopPool);
const dsTokensMock = vi.mocked(dsTokens);
const dsLatestListingsMock = vi.mocked(dsLatestListings);
const pumpNewestMock = vi.mocked(pumpNewest);

const NOW = Date.parse('2026-10-01T21:10:30Z');
const HOUR = 3_600_000;
const FIRED = '6nyVgjjPGY9c7QpjMUPY8vS6sLzVoiq9VyxYoTvmpump';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
/** a profile-only listing from ds_profiles_latest.json */
const LISTED = '9BeFTeAoSAebH44zJM2TfSNuBmuDGaBUPkG6sB6pKbux';
/** a boost-only listing from ds_boosts_latest.json */
const BOOSTED = 'AMSYLBsmp6t3kMd3j7vFACU6hkF7oH1NNkyvozrVPMYe';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

const gtSolana = () => parseGtPools(fixture('gt_new_pools_solana.json'), 'solana', NOW);
const pumpCoins = () => parsePumpCoins(fixture('pumpfun_newest.json'), NOW);
const listings = (): DsListing[] => {
  const profiles = parseDsListings(fixture('ds_profiles_latest.json'));
  const boosts = parseDsListings(fixture('ds_boosts_latest.json'), true);
  const boostedKeys = new Set(boosts.map((b) => b.address));
  return [...profiles.filter((p) => !boostedKeys.has(p.address)), ...boosts];
};

/** DexScreener's view of a few discovered tokens (test input for the refresh step) */
function dsRefresh(addresses: string[]): TokenSnapshot[] {
  const known: Record<string, Partial<TokenSnapshot>> = {
    [FIRED]: {
      symbol: 'FIRED',
      name: 'FIRED',
      pairAddress: 'JEAR6z8whbYFGrAJ4iDUE6GjrJwZRy8EaxwZf7jG2FkE',
      dex: 'pumpfun',
      priceUsd: 0.0000071,
      marketCapUsd: 7100,
      liquidityUsd: 9000,
      volumeUsd: { m5: 800, h1: 900 },
      txns: { m5: { buys: 12, sells: 3, buyers: null, sellers: null } },
      createdAt: Date.parse('2026-10-01T21:09:57Z'),
    },
    [LISTED]: { symbol: 'HIGHER', name: 'Higherpad', liquidityUsd: 50_000, createdAt: NOW - 2 * HOUR },
    [BOOSTED]: { symbol: 'LGZ', name: 'Local Game Zone', liquidityUsd: 20_000, createdAt: NOW - 3 * 24 * HOUR },
  };
  return addresses
    .filter((a) => known[a])
    .map((a) => ({ ...emptySnapshot('solana', a, NOW), ...known[a], sources: ['dexscreener'] }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.resetAllMocks();
  gtNewPoolsMock.mockResolvedValue(gtSolana());
  pumpNewestMock.mockResolvedValue(pumpCoins());
  dsLatestListingsMock.mockResolvedValue(listings());
  dsTokensMock.mockImplementation(async (_ds, _chain, addrs) => dsRefresh(addrs));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chain configs', () => {
  it('describes the four supported chains', () => {
    expect(Object.keys(CHAIN_CONFIGS)).toEqual(['solana', 'ethereum', 'base', 'bsc']);
    expect(CHAIN_CONFIGS.ethereum.geckoNetwork).toBe('eth');
    expect(CHAIN_CONFIGS.bsc.dexscreenerChainId).toBe('bsc');
    expect(CHAIN_CONFIGS.solana.color).toBe('#b18cff');
    expect(CHAIN_CONFIGS.base.explorerTokenUrl('0xabc')).toBe('https://basescan.org/token/0xabc');
    expect(CHAIN_CONFIGS.solana.explorerTokenUrl(BONK)).toBe(`https://solscan.io/token/${BONK}`);
  });

  it('validates and normalizes addresses per chain', () => {
    const [sol, eth] = createChainAdapters(['solana', 'ethereum']);
    const evm = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
    expect(sol!.isAddress(BONK)).toBe(true);
    expect(sol!.isAddress(` ${BONK} `)).toBe(true);
    expect(sol!.isAddress(evm)).toBe(false);
    expect(sol!.isAddress('BONK')).toBe(false);
    expect(sol!.normalizeAddress(BONK)).toBe(BONK);
    expect(eth!.isAddress(evm)).toBe(true);
    expect(eth!.isAddress(BONK)).toBe(false);
    expect(eth!.normalizeAddress(evm)).toBe(evm.toLowerCase());
  });

  it('creates one adapter per chain id, in order, without duplicates', () => {
    const adapters = createChainAdapters(['base', 'solana', 'base']);
    expect(adapters.map((a) => a.config.id)).toEqual(['base', 'solana']);
  });
});

describe('adapter.discover', () => {
  it('merges GeckoTerminal, pump.fun and DexScreener listings, then refreshes market data', async () => {
    const tokens = await createAdapter(CHAIN_CONFIGS.solana).discover();

    expect(gtNewPoolsMock).toHaveBeenCalledWith('solana', 'solana');
    expect(pumpNewestMock).toHaveBeenCalledWith(40);
    expect(dsTokensMock).toHaveBeenCalledTimes(1);
    const [dsChain, chain, refreshed] = dsTokensMock.mock.calls[0]!;
    expect([dsChain, chain]).toEqual(['solana', 'solana']);
    expect(refreshed.length).toBe(60);
    // GeckoTerminal pools get refresh priority
    expect(refreshed.slice(0, 20)).toEqual(gtSolana().map((s) => s.address));

    const fired = tokens.find((t) => t.address === FIRED)!;
    expect(fired.sources).toEqual(['geckoterminal', 'pumpfun', 'dexscreener']);
    expect(fired.liquidityUsd).toBe(9000);
    expect(fired.marketCapUsd).toBe(7100);
    expect(fired.fdvUsd).toBeCloseTo(5732.185856);
    expect(fired.txns.m5).toEqual({ buys: 12, sells: 3, buyers: 1, sellers: 0 });
    expect(fired.txns.h24).toEqual({ buys: 1, sells: 0, buyers: 1, sellers: 0 });
    expect(fired.links.some((l) => l.type === 'twitter')).toBe(true);

    // listing filled by the refresh is kept; too old and unidentified listings are dropped
    expect(tokens.find((t) => t.address === LISTED)).toMatchObject({ symbol: 'HIGHER', sources: ['dexscreener'] });
    expect(tokens.find((t) => t.address === BOOSTED)).toBeUndefined();
    expect(tokens.every((t) => t.symbol !== '')).toBe(true);

    const keys = tokens.map((t) => t.address);
    expect(new Set(keys).size).toBe(keys.length);
    const created = tokens.map((t) => t.createdAt ?? Number.NEGATIVE_INFINITY);
    expect(created).toEqual([...created].sort((a, b) => b - a));

    const expected = new Set([...gtSolana(), ...pumpCoins()].map((s) => s.address));
    expected.add(LISTED);
    expect(new Set(keys)).toEqual(expected);
  });

  it('marks boosted listings', async () => {
    dsTokensMock.mockImplementation(async (_ds, _chain, addrs) =>
      addrs.includes(BOOSTED) ? [{ ...emptySnapshot('solana', BOOSTED, NOW), symbol: 'LGZ', createdAt: NOW - HOUR }] : [],
    );
    gtNewPoolsMock.mockResolvedValue([]);
    pumpNewestMock.mockResolvedValue([]);
    const tokens = await createAdapter(CHAIN_CONFIGS.solana).discover();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ address: BOOSTED, boosted: true, symbol: 'LGZ' });
  });

  it('tolerates failing sources and returns what the others found', async () => {
    gtNewPoolsMock.mockRejectedValue(new Error('HTTP 429'));
    dsLatestListingsMock.mockRejectedValue(new Error('timeout'));
    const tokens = await createAdapter(CHAIN_CONFIGS.solana).discover();
    expect(new Set(tokens.map((t) => t.address))).toEqual(new Set(pumpCoins().map((s) => s.address)));
    expect(tokens.find((t) => t.address === FIRED)?.sources).toEqual(['pumpfun', 'dexscreener']);
  });

  it('keeps discovery data when the DexScreener refresh fails', async () => {
    dsTokensMock.mockRejectedValue(new Error('HTTP 503'));
    const tokens = await createAdapter(CHAIN_CONFIGS.solana).discover();
    const fired = tokens.find((t) => t.address === FIRED)!;
    expect(fired.liquidityUsd).toBeCloseTo(4058.48688356686);
    expect(fired.sources).toEqual(['geckoterminal', 'pumpfun']);
    expect(tokens.some((t) => t.address === LISTED)).toBe(false);
  });

  it('throws only when every discovery source failed', async () => {
    gtNewPoolsMock.mockRejectedValue(new Error('gt down'));
    dsLatestListingsMock.mockRejectedValue(new Error('ds down'));
    pumpNewestMock.mockRejectedValue(new Error('pump down'));
    await expect(createAdapter(CHAIN_CONFIGS.solana).discover()).rejects.toThrow(
      /all discovery sources failed.*gt down.*ds down.*pump down/,
    );
    expect(dsTokensMock).not.toHaveBeenCalled();
  });

  it('polls GeckoTerminal new_pools at most every 55 s (its CDN TTL) while other sources run every cycle', async () => {
    const adapter = createAdapter(CHAIN_CONFIGS.solana);
    await adapter.discover();
    vi.setSystemTime(NOW + 30_000);
    const second = await adapter.discover();
    expect(gtNewPoolsMock).toHaveBeenCalledTimes(1);
    expect(pumpNewestMock).toHaveBeenCalledTimes(2);
    expect(dsLatestListingsMock).toHaveBeenCalledTimes(2);
    expect(second.some((t) => t.sources.includes('geckoterminal'))).toBe(false);

    // a failed attempt also waits for the next window
    gtNewPoolsMock.mockRejectedValueOnce(new Error('HTTP 429'));
    vi.setSystemTime(NOW + 60_000);
    await adapter.discover();
    vi.setSystemTime(NOW + 90_000);
    await adapter.discover();
    expect(gtNewPoolsMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(NOW + 120_000);
    await adapter.discover();
    expect(gtNewPoolsMock).toHaveBeenCalledTimes(3);
  });

  it('drops tokens older than maxTokenAgeHours', async () => {
    dsTokensMock.mockResolvedValue([]);
    const tokens = await createAdapter(CHAIN_CONFIGS.solana, { maxTokenAgeHours: 40 / 3600 }).discover();
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((t) => t.createdAt !== null && NOW - t.createdAt <= 40_000)).toBe(true);
  });

  it('EVM chains skip pump.fun and use their own network ids', async () => {
    const pools = parseGtPools(fixture('gt_new_pools_base.json'), 'base', NOW);
    gtNewPoolsMock.mockResolvedValue(pools);
    dsTokensMock.mockResolvedValue([]);
    const tokens = await createAdapter(CHAIN_CONFIGS.base).discover();
    expect(pumpNewestMock).not.toHaveBeenCalled();
    expect(gtNewPoolsMock).toHaveBeenCalledWith('base', 'base');
    expect(dsTokensMock.mock.calls[0]?.[0]).toBe('base');
    // only pools from the last 24h, and no Solana listings leak in
    expect(tokens.map((t) => t.address).sort()).toEqual(pools.map((p) => p.address).sort());
  });

  it('dedupes EVM addresses case-insensitively', async () => {
    const pools = parseGtPools(fixture('gt_new_pools_base.json'), 'base', NOW);
    const first = pools[0]!;
    gtNewPoolsMock.mockResolvedValue(pools);
    dsLatestListingsMock.mockResolvedValue([
      { dsChainId: 'base', address: first.address.toUpperCase().replace('0X', '0x'), boosted: true, links: [], imageUrl: null },
    ]);
    dsTokensMock.mockResolvedValue([]);
    const tokens = await createAdapter(CHAIN_CONFIGS.base).discover();
    const matches = tokens.filter((t) => t.address.toLowerCase() === first.address.toLowerCase());
    expect(matches).toHaveLength(1);
    expect(matches[0]!.boosted).toBe(true);
  });
});

describe('adapter.refresh / enrich', () => {
  it('refresh delegates to the DexScreener batch call', async () => {
    const adapter = createAdapter(CHAIN_CONFIGS.bsc);
    await expect(adapter.refresh([])).resolves.toEqual([]);
    expect(dsTokensMock).not.toHaveBeenCalled();
    dsTokensMock.mockResolvedValue([]);
    await adapter.refresh(['0x2B449C94A9164979e2FEa22E789c437102569303']);
    expect(dsTokensMock).toHaveBeenCalledWith('bsc', 'bsc', ['0x2B449C94A9164979e2FEa22E789c437102569303']);
  });

  it('enrich reads GeckoTerminal token info', async () => {
    gtTokenInfoMock.mockResolvedValue(parseGtTokenInfo(fixture('gt_token_info_bonk.json')));
    const info = await createAdapter(CHAIN_CONFIGS.solana).enrich(BONK);
    expect(gtTokenInfoMock).toHaveBeenCalledWith('solana', BONK);
    expect(info?.holders).toBe(1024516);
  });

  it('enrich adds the unique-wallet counts of the main pool, and survives a failed pool lookup', async () => {
    gtTokenInfoMock.mockResolvedValue(parseGtTokenInfo(fixture('gt_token_info_bonk.json')));
    const pool = parseGtTokenPools(fixture('gt_token_pools_bonk.json'), 'solana', BONK, NOW)!;
    gtTokenTopPoolMock.mockResolvedValue(pool);
    const adapter = createAdapter(CHAIN_CONFIGS.solana);
    const info = await adapter.enrich(BONK);
    expect(gtTokenTopPoolMock).toHaveBeenCalledWith('solana', 'solana', BONK);
    expect(info?.wallets).toEqual({ pairAddress: pool.pairAddress, txns: pool.txns });
    expect(info?.wallets?.txns.m5?.buyers).toBe(8);

    gtTokenTopPoolMock.mockRejectedValue(new Error('HTTP 429'));
    const degraded = await adapter.enrich(BONK);
    expect(degraded?.holders).toBe(1024516);
    expect(degraded?.wallets).toBeUndefined();
  });
});

describe('adapter.lookup', () => {
  beforeEach(() => {
    dsTokensMock.mockImplementation(async (_ds, chain, addrs) =>
      parseDsPairs(fixture('ds_tokens_solana.json'), chain, NOW).filter((s) => addrs.includes(s.address)),
    );
    gtTokenTopPoolMock.mockResolvedValue(parseGtTokenPools(fixture('gt_token_pools_bonk.json'), 'solana', BONK, NOW));
    gtTokenInfoMock.mockResolvedValue(parseGtTokenInfo(fixture('gt_token_info_bonk.json')));
  });

  it('combines DexScreener market data, GeckoTerminal wallets/windows and token info', async () => {
    const snap = await createAdapter(CHAIN_CONFIGS.solana).lookup(BONK);
    expect(gtTokenTopPoolMock).toHaveBeenCalledWith('solana', 'solana', BONK);
    expect(snap).toMatchObject({
      chain: 'solana',
      address: BONK,
      symbol: 'Bonk',
      liquidityUsd: 425802.43,
      priceUsd: 0.000003757,
      marketCapUsd: 330661627,
      holders: 1024516,
      top10HolderPct: 38.3289,
      createdAt: 1671980424000,
      sources: ['geckoterminal', 'dexscreener'],
    });
    expect(snap!.txns.m5).toEqual({ buys: 10, sells: 10, buyers: 8, sellers: 6 });
    expect(snap!.txns.m15).toEqual({ buys: 27, sells: 66, buyers: 20, sellers: 45 });
    expect(snap!.security?.mintAuthority).toBe(false);
    expect(snap!.links.map((l) => l.url)).toContain('https://t.me/Official_Bonk_Inu');
  });

  it('never mixes two different pools: the deeper one wins and the other adds token-level facts only', async () => {
    const gtPool = parseGtTokenPools(fixture('gt_token_pools_bonk.json'), 'solana', BONK, NOW)!;
    const dsPair = parseDsPairs(fixture('ds_tokens_solana.json'), 'solana', NOW).find((s) => s.address === BONK)!;
    // DexScreener's token endpoint answered with a shallow side pool
    dsTokensMock.mockResolvedValue([
      { ...dsPair, pairAddress: 'SidePooL1111111111111111111111111111111111', liquidityUsd: 20_000, volumeUsd: { m5: 1, h1: 2 } },
    ]);
    const snap = await createAdapter(CHAIN_CONFIGS.solana).lookup(BONK);
    expect(snap).toMatchObject({ pairAddress: gtPool.pairAddress, liquidityUsd: gtPool.liquidityUsd });
    expect(snap!.volumeUsd).toEqual(gtPool.volumeUsd);
    expect(snap!.txns).toEqual(gtPool.txns);
    expect(snap!.sources).toEqual(['geckoterminal', 'dexscreener']);
    expect(snap!.holders).toBe(1024516);
  });

  it('works from GeckoTerminal alone when DexScreener fails', async () => {
    dsTokensMock.mockRejectedValue(new Error('HTTP 500'));
    const snap = await createAdapter(CHAIN_CONFIGS.solana).lookup(BONK);
    expect(snap).toMatchObject({ liquidityUsd: 425990.0243, holders: 1024516, sources: ['geckoterminal'] });
  });

  it('returns null for unknown tokens and non-addresses', async () => {
    dsTokensMock.mockResolvedValue([]);
    gtTokenTopPoolMock.mockResolvedValue(null);
    const adapter = createAdapter(CHAIN_CONFIGS.solana);
    await expect(adapter.lookup(BONK)).resolves.toBeNull();
    await expect(adapter.lookup('pepe')).resolves.toBeNull();
    await expect(createAdapter(CHAIN_CONFIGS.base).lookup(BONK)).resolves.toBeNull();
  });

  it('throws when every source failed', async () => {
    dsTokensMock.mockRejectedValue(new Error('a'));
    gtTokenTopPoolMock.mockRejectedValue(new Error('b'));
    gtTokenInfoMock.mockRejectedValue(new Error('c'));
    await expect(createAdapter(CHAIN_CONFIGS.solana).lookup(BONK)).rejects.toThrow('lookup failed');
  });
});
