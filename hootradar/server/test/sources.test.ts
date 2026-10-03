import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenSnapshot } from '../../shared/types.js';
import { fetchJson } from '../src/net/http.js';
import {
  dsLatestListings,
  dsSearch,
  dsTokens,
  pairLiquidity,
  pairLiquidityInfo,
  parseDsListings,
  parseDsPairs,
} from '../src/sources/dexscreener.js';
import { parseGtPools, parseGtTokenInfo, parseGtTokenPools } from '../src/sources/geckoterminal.js';
import { emptySnapshot, mergeAcrossPools, mergeSnapshots, toEpochMs, toNum } from '../src/sources/merge.js';
import { parsePumpCoins } from '../src/sources/pumpfun.js';

vi.mock('../src/net/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/net/http.js')>()),
  fetchJson: vi.fn(),
}));
const fetchJsonMock = vi.mocked(fetchJson);

const TS = Date.parse('2026-10-01T21:10:30Z');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

function bySymbol(snaps: TokenSnapshot[], symbol: string): TokenSnapshot {
  const s = snaps.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`no ${symbol}`);
  return s;
}

beforeEach(() => {
  fetchJsonMock.mockReset();
});

describe('field parsers', () => {
  it('toNum accepts numbers and numeric strings only', () => {
    expect(toNum('4058.48688356686')).toBeCloseTo(4058.48688356686);
    expect(toNum(12)).toBe(12);
    expect(toNum('0')).toBe(0);
    for (const bad of ['', '  ', null, undefined, 'abc', Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      expect(toNum(bad)).toBeNull();
    }
  });

  it('toEpochMs handles ISO strings, ms and seconds', () => {
    expect(toEpochMs('2026-10-01T21:09:57Z')).toBe(Date.parse('2026-10-01T21:09:57Z'));
    expect(toEpochMs(1790889008000)).toBe(1790889008000);
    expect(toEpochMs(1790889008)).toBe(1790889008000);
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs('not a date')).toBeNull();
  });
});

describe('GeckoTerminal parsers', () => {
  it('maps new_pools (solana) with token names from included[]', () => {
    const snaps = parseGtPools(fixture('gt_new_pools_solana.json'), 'solana', TS);
    expect(snaps).toHaveLength(20);
    const fired = bySymbol(snaps, 'FIRED');
    expect(fired).toMatchObject({
      chain: 'solana',
      address: '6nyVgjjPGY9c7QpjMUPY8vS6sLzVoiq9VyxYoTvmpump',
      name: 'FIRED',
      pairAddress: 'JEAR6z8whbYFGrAJ4iDUE6GjrJwZRy8EaxwZf7jG2FkE',
      dex: 'Pump.fun',
      ts: TS,
      marketCapUsd: null,
      fdvUsd: 5732.185856,
      liquidityUsd: 4058.48688356686,
      createdAt: Date.parse('2026-10-01T21:09:57Z'),
      sources: ['geckoterminal'],
      boosted: false,
      holders: null,
      security: null,
    });
    expect(fired.priceUsd).toBeCloseTo(0.0000065271985943, 15);
    expect(fired.volumeUsd.m5).toBeCloseTo(15.2919204753);
    expect(fired.priceChangePct.h1).toBe(0);
    expect(fired.txns.m5).toEqual({ buys: 1, sells: 0, buyers: 1, sellers: 0 });
    expect(Object.keys(fired.txns)).toEqual(['m5', 'm15', 'm30', 'h1', 'h6', 'h24']);
  });

  it('decides the quote side by address, so a token named "SOL" is still the token', () => {
    const snaps = parseGtPools(fixture('gt_new_pools_solana.json'), 'solana', TS);
    const fakeSol = snaps.find((s) => s.address === 'GuK8KZRTmTx8u8FQ1S7eBR7pstYpNXBrsgKS7rFjpump');
    expect(fakeSol?.symbol).toBe('SOL');
    expect(snaps.some((s) => s.address === 'So11111111111111111111111111111111111111112')).toBe(false);
  });

  it('maps base pools paired with native ETH (v4) and WETH', () => {
    const snaps = parseGtPools(fixture('gt_new_pools_base.json'), 'base', TS);
    expect(snaps).toHaveLength(20);
    const bhd = bySymbol(snaps, 'BHD');
    expect(bhd.address).toBe('0x835e7932f6448ee5c64e92d2e6805c7038ce2d26');
    expect(bhd.dex).toBe('Uniswap V4 (Base)');
    const flx = bySymbol(snaps, 'FLX');
    expect(flx.liquidityUsd).toBeCloseTo(13610.7654);
    const quoteAddrs = ['0x0000000000000000000000000000000000000000', '0x4200000000000000000000000000000000000006'];
    expect(snaps.filter((s) => quoteAddrs.includes(s.address))).toHaveLength(0);
  });

  it('inverts a pool whose base is the quote asset', () => {
    const doc = structuredClone(fixture('gt_new_pools_solana.json')) as {
      data: Array<{ relationships: Record<string, { data: { id: string } }>; attributes: Record<string, unknown> }>;
    };
    const pool = doc.data[0]!;
    const { base_token, quote_token } = pool.relationships;
    pool.relationships.base_token = quote_token!;
    pool.relationships.quote_token = base_token!;
    pool.attributes.transactions = { m5: { buys: 7, sells: 3, buyers: 5, sellers: 2 } };
    const snap = parseGtPools({ ...doc, data: [pool] }, 'solana', TS)[0]!;
    expect(snap.address).toBe('6nyVgjjPGY9c7QpjMUPY8vS6sLzVoiq9VyxYoTvmpump');
    expect(snap.priceUsd).toBeCloseTo(118.059372426241);
    expect(snap.fdvUsd).toBeNull();
    expect(snap.priceChangePct).toEqual({});
    expect(snap.txns.m5).toEqual({ buys: 3, sells: 7, buyers: 2, sellers: 5 });
  });

  it('falls back to the pool name for symbols when included[] is missing', () => {
    const doc = fixture('gt_new_pools_base.json') as Record<string, unknown>;
    const snaps = parseGtPools({ data: doc.data }, 'base', TS);
    const bhd = snaps.find((s) => s.address === '0x835e7932f6448ee5c64e92d2e6805c7038ce2d26');
    expect(bhd).toMatchObject({ symbol: 'BHD', name: 'BHD', dex: 'uniswap-v4-base' });
  });

  it('maps token info (BONK holders, concentration, security, socials)', () => {
    const info = parseGtTokenInfo(fixture('gt_token_info_bonk.json'));
    expect(info).not.toBeNull();
    expect(info!.holders).toBe(1024516);
    expect(info!.holders!).toBeGreaterThan(1e6);
    expect(info!.top10HolderPct).toBeCloseTo(38.3289);
    expect(info!.security).toEqual({ mintAuthority: false, freezeAuthority: false, honeypot: 'unknown', devHoldingPct: 0 });
    expect(info!.imageUrl).toContain('bonk.jpg');
    expect(info!.links).toEqual([
      { type: 'website', url: 'https://www.bonkcoin.com' },
      { type: 'twitter', url: 'https://x.com/bonk_inu' },
      { type: 'discord', url: 'https://discord.gg/ubqvDDFUhf' },
    ]);
  });

  it('returns null token info for an empty document', () => {
    expect(parseGtTokenInfo({})).toBeNull();
    expect(parseGtTokenInfo(null)).toBeNull();
  });

  it('picks the most liquid pool where the token is base', () => {
    const snap = parseGtTokenPools(
      fixture('gt_token_pools_bonk.json'),
      'solana',
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      TS,
    );
    expect(snap).toMatchObject({
      address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      symbol: 'Bonk',
      pairAddress: '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9',
      dex: 'orca',
      priceUsd: 0.000003753821771,
      marketCapUsd: 330315206.786464,
      liquidityUsd: 425990.0243,
      createdAt: Date.parse('2023-07-05T14:41:09Z'),
    });
    expect(snap!.txns.m5).toEqual({ buys: 10, sells: 7, buyers: 8, sellers: 6 });
    expect(snap!.txns.m15).toEqual({ buys: 27, sells: 66, buyers: 20, sellers: 45 });
    expect(snap!.volumeUsd.m30).toBeCloseTo(6592.2188017433);
  });

  it('returns null when the token is in none of the pools', () => {
    expect(parseGtTokenPools(fixture('gt_token_pools_bonk.json'), 'solana', 'NotThere111111111111111111111111', TS)).toBeNull();
  });
});

describe('DexScreener parsers', () => {
  it('maps tokens/v1 pairs (BONK, WIF)', () => {
    const snaps = parseDsPairs(fixture('ds_tokens_solana.json'), 'solana', TS);
    expect(snaps.map((s) => s.symbol)).toEqual(['Bonk', '$WIF']);
    const bonk = snaps[0]!;
    expect(bonk).toMatchObject({
      chain: 'solana',
      address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      name: 'Bonk',
      pairAddress: '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9',
      dex: 'orca',
      priceUsd: 0.000003757,
      marketCapUsd: 330661627,
      fdvUsd: 333924185,
      liquidityUsd: 425802.43,
      createdAt: 1671980424000,
      sources: ['dexscreener'],
      boosted: false,
    });
    expect(bonk.txns).toEqual({
      m5: { buys: 10, sells: 10, buyers: null, sellers: null },
      h1: { buys: 133, sells: 223, buyers: null, sellers: null },
      h6: { buys: 2990, sells: 3777, buyers: null, sellers: null },
      h24: { buys: 8364, sells: 9020, buyers: null, sellers: null },
    });
    expect(bonk.volumeUsd).toEqual({ m5: 487.23, h1: 15122.45, h6: 423223.91, h24: 904228.83 });
    expect(bonk.priceChangePct.h6).toBe(2.48);
    expect(bonk.imageUrl).toMatch(/^https:\/\/cdn\.dexscreener\.com\//);
    expect(bonk.links.map((l) => l.type)).toEqual(['website', 'twitter', 'telegram', 'discord']);
  });

  it('search returns one snapshot per (chain, address) from the most liquid pair', () => {
    const snaps = parseDsPairs(fixture('ds_search_pepe.json'), null, TS);
    expect(snaps).toHaveLength(29);
    const basePepe = snaps.filter((s) => s.address === '0x52b492a33E447Cdb854c7FC19F1e57E8BfA1777D');
    expect(basePepe).toHaveLength(1);
    expect(basePepe[0]).toMatchObject({ chain: 'base', dex: 'uniswap', liquidityUsd: 371323.03, createdAt: 1723143983000 });
    const ethPepe = snaps.find((s) => s.chain === 'ethereum');
    expect(ethPepe).toMatchObject({ address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', liquidityUsd: 32113393.11 });
    expect(snaps.find((s) => s.chain === 'tron')?.links).toEqual([]);
  });

  it('does not trust liquidity that the quote reserve cannot back (fake-priced or single-sided pools)', () => {
    const snaps = parseDsPairs(fixture('ds_search_pepe.json'), null, TS);
    const liq = (address: string) => snaps.find((s) => s.address === address)?.liquidityUsd;
    // real fixture: reports $3,900,571.79 against 0.4 % of that in USDC → quote-backed value
    expect(liq('A1DBHWmtuYZMpLNXE9xr4B7crD8FAxwHSDnqnk8NwAKS')).toBeLessThan(100);
    expect(liq('A1DBHWmtuYZMpLNXE9xr4B7crD8FAxwHSDnqnk8NwAKS')).toBeGreaterThan(0);
    expect(liq('0x4a5d095b3DDbf2776E9Bb42c90E51ed96005EF9f')).toBeLessThan(100); // "Pepe Army", $323K reported
    // balanced pools keep the reported figure, including a 1.4x concentrated one
    expect(liq('0x6982508145454Ce325dDbE47a25d4ec3d2311933')).toBe(32113393.11);
    expect(liq('0x52b492a33E447Cdb854c7FC19F1e57E8BfA1777D')).toBe(371323.03);

    // quote price = priceUsd / priceNative = $3,930 (ETH); the cut-off is 10x the quote backing
    const launchPool = (quote: number) => ({
      liquidity: { usd: 67_265.51, base: 1e9, quote },
      priceUsd: '0.0000672',
      priceNative: '0.0000000171',
    });
    expect(pairLiquidity(launchPool(1.25))).toBe(67_265.51); // backed $9.8K, 6.8x → kept
    expect(pairLiquidity(launchPool(0.6))).toBeCloseTo(2 * 0.6 * (0.0000672 / 0.0000000171), 1); // 14x → $4.7K
    expect(pairLiquidity({ liquidity: { usd: 5_000 } })).toBe(5_000); // no reserves → as reported
    expect(pairLiquidity({})).toBeNull();
    // the two series are flagged so growth is never measured across the switch
    expect(pairLiquidityInfo(launchPool(1.25)).adjusted).toBe(false);
    expect(pairLiquidityInfo(launchPool(0.6)).adjusted).toBe(true);
    const capped = parseDsPairs(fixture('ds_search_pepe.json'), null, TS).find(
      (s) => s.address === 'A1DBHWmtuYZMpLNXE9xr4B7crD8FAxwHSDnqnk8NwAKS',
    );
    expect(capped).toMatchObject({ liquiditySource: 'dexscreener', liquidityAdjusted: true });
  });

  it('records the creation time of the pool the windows come from', () => {
    const snaps = parseDsPairs(fixture('ds_search_pepe.json'), null, TS);
    for (const s of snaps) {
      expect(s.pairCreatedAt === null || typeof s.pairCreatedAt === 'number').toBe(true);
      if (s.pairCreatedAt != null && s.createdAt != null) expect(s.pairCreatedAt).toBeGreaterThanOrEqual(s.createdAt);
    }
    const gt = parseGtPools(fixture('gt_new_pools_base.json'), 'base', TS);
    expect(gt.every((s) => s.pairCreatedAt === s.createdAt && s.liquiditySource === 'geckoterminal')).toBe(true);
  });

  it('marks pairs with active boosts', () => {
    const pairs = structuredClone(fixture('ds_tokens_solana.json')) as Array<Record<string, unknown>>;
    pairs[1]!.boosts = { active: 3 };
    const snaps = parseDsPairs(pairs, 'solana', TS);
    expect(snaps.map((s) => s.boosted)).toEqual([false, true]);
  });

  it('maps latest profiles', () => {
    const listings = parseDsListings(fixture('ds_profiles_latest.json'));
    expect(listings).toHaveLength(30);
    expect(listings[0]).toEqual({
      dsChainId: 'solana',
      address: '9BeFTeAoSAebH44zJM2TfSNuBmuDGaBUPkG6sB6pKbux',
      boosted: false,
      imageUrl:
        'https://cdn.dexscreener.com/cms/images/s4KltJYx24LQv7Bo?width=64&height=64&fit=crop&quality=95&format=auto',
      links: [
        { type: 'website', url: 'https://higherpad.com', label: 'Website' },
        { type: 'twitter', url: 'https://x.com/Higherpad' },
      ],
    });
  });

  it('maps latest boosts (bare icon ids, unknown social kinds, duplicates)', () => {
    const listings = parseDsListings(fixture('ds_boosts_latest.json'), true);
    expect(listings).toHaveLength(27);
    expect(listings.every((l) => l.boosted)).toBe(true);
    const first = listings[0]!;
    expect(first.imageUrl).toBe(
      'https://cdn.dexscreener.com/cms/images/Ar0G61kTU__w8-JN?width=64&height=64&fit=crop&quality=95&format=auto',
    );
    expect(first.links[0]).toMatchObject({ type: 'other', label: 'tiktok' });
    const anon = listings.find((l) => l.address === 'EZM9ZBioM6fw2XiSakaLuWUfNWonCtv9xVthLY6Dpump')!;
    expect(anon.links).toEqual([
      { type: 'other', url: 'https://fomo.family/profile/anon_ai' },
      { type: 'twitter', url: 'https://x.com/anon_onfomo' },
    ]);
  });
});

describe('DexScreener fetchers', () => {
  it('dsTokens batches by 30, keeps only requested BASE tokens', async () => {
    const tokens = fixture('ds_tokens_solana.json') as unknown[];
    fetchJsonMock.mockResolvedValue(tokens);
    const addresses = ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', ...Array.from({ length: 64 }, (_, i) => `Addr${i}`)];
    const snaps = await dsTokens('solana', 'solana', addresses);
    expect(fetchJsonMock).toHaveBeenCalledTimes(3);
    const urls = fetchJsonMock.mock.calls.map((c) => c[0]);
    expect(urls[0]).toMatch(/^https:\/\/api\.dexscreener\.com\/tokens\/v1\/solana\//);
    expect(urls.map((u) => u.split('/').pop()!.split(',').length)).toEqual([30, 30, 5]);
    expect(fetchJsonMock.mock.calls[0]?.[1]).toMatchObject({ limiter: 'dexscreener' });
    // WIF is in the response but was not requested; BONK appears once although every batch returned it
    expect(snaps.map((s) => s.address)).toEqual(['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263']);
  });

  it('dsTokens tolerates a failed batch but throws when all fail', async () => {
    const tokens = fixture('ds_tokens_solana.json');
    const addrs = Array.from({ length: 31 }, (_, i) => (i === 0 ? 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' : `A${i}`));
    fetchJsonMock.mockResolvedValueOnce(tokens).mockRejectedValueOnce(new Error('HTTP 503'));
    await expect(dsTokens('solana', 'solana', addrs)).resolves.toHaveLength(1);

    fetchJsonMock.mockRejectedValue(new Error('HTTP 503'));
    await expect(dsTokens('solana', 'solana', addrs)).rejects.toThrow('HTTP 503');
  });

  it('dsTokens with no addresses makes no request', async () => {
    await expect(dsTokens('solana', 'solana', [])).resolves.toEqual([]);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  it('dsTokens matches EVM addresses case-insensitively', async () => {
    const pairs = (fixture('ds_search_pepe.json') as { pairs: unknown[] }).pairs;
    fetchJsonMock.mockResolvedValue(pairs);
    const snaps = await dsTokens('ethereum', 'ethereum', ['0x6982508145454ce325ddbe47a25d4ec3d2311933']);
    expect(snaps.map((s) => s.address)).toContain('0x6982508145454Ce325dDbE47a25d4ec3d2311933');
  });

  it('dsSearch is cached and spans all chains', async () => {
    fetchJsonMock.mockResolvedValue(fixture('ds_search_pepe.json'));
    const snaps = await dsSearch(' pepe ');
    expect(fetchJsonMock.mock.calls[0]?.[0]).toBe('https://api.dexscreener.com/latest/dex/search?q=pepe');
    expect(fetchJsonMock.mock.calls[0]?.[1]).toMatchObject({ limiter: 'dexscreener', cacheTtlMs: 30000 });
    expect(new Set(snaps.map((s) => s.chain))).toEqual(
      new Set(['robinhood', 'solana', 'base', 'ethereum', 'monad', 'pulsechain', 'tron', 'xrpl']),
    );
    await expect(dsSearch('   ')).resolves.toEqual([]);
  });

  it('dsLatestListings merges profiles and boosts; boosted wins', async () => {
    fetchJsonMock.mockImplementation(async (url: string) =>
      fixture(url.includes('token-boosts') ? 'ds_boosts_latest.json' : 'ds_profiles_latest.json'),
    );
    const listings = await dsLatestListings();
    expect(listings).toHaveLength(54);
    const both = listings.find((l) => l.address === 'EZM9ZBioM6fw2XiSakaLuWUfNWonCtv9xVthLY6Dpump')!;
    expect(both.boosted).toBe(true);
    expect(fetchJsonMock.mock.calls.every((c) => c[1]?.limiter === 'dexscreener-meta')).toBe(true);
  });

  it('dsLatestListings survives one feed failing, throws when both fail', async () => {
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes('token-boosts')) throw new Error('HTTP 429');
      return fixture('ds_profiles_latest.json');
    });
    await expect(dsLatestListings()).resolves.toHaveLength(30);
    fetchJsonMock.mockRejectedValue(new Error('down'));
    await expect(dsLatestListings()).rejects.toThrow('down');
  });
});

describe('pump.fun parser', () => {
  it('maps the newest coins', () => {
    const snaps = parsePumpCoins(fixture('pumpfun_newest.json'), TS);
    expect(snaps).toHaveLength(20);
    const john = snaps[0]!;
    expect(john).toMatchObject({
      chain: 'solana',
      address: 'AM2Sex82MwT9d4EnYme8f3a9Qr82C5bMpffXKpGnpump',
      symbol: 'John',
      name: 'I Am John Doe',
      dex: 'pump.fun',
      pairAddress: 'FwbmjW41mTX1HhADB2UwmMYgrJ5ZcZeGMUntf1pKU3iU',
      marketCapUsd: 3299.5115024123006,
      createdAt: 1790889008000,
      imageUrl: 'https://ipfs.io/ipfs/bafybeiep552xsgoxbog2f76tvj6tw7poyd5kfphfnyaytivu6jt565iuc4',
      liquidityUsd: null,
      volumeUsd: {},
      txns: {},
      sources: ['pumpfun'],
    });
    // 1e15 raw supply at 6 decimals = 1e9 tokens
    expect(john.priceUsd).toBeCloseTo(3299.5115024123006 / 1e9, 15);
    const amgd = bySymbol(snaps, 'AMGD');
    expect(amgd.links).toEqual([
      { type: 'twitter', url: 'https://x.com/MercedesAMGF1?s=20' },
      { type: 'website', url: 'https://share.google/sFf3FXNwKaYKUH1h5' },
    ]);
  });

  it('never takes the SOL-denominated market_cap as USD and skips banned coins', () => {
    const snaps = parsePumpCoins(
      [
        { mint: 'M1', symbol: 'A', market_cap: 27.9, total_supply: 1e15, base_decimals: 6 },
        { mint: 'M2', symbol: 'B', usd_market_cap: 5000, is_banned: true },
        { mint: 'M3', symbol: 'C', market_cap_usd: 4000, complete: true, pool_address: 'POOL' },
      ],
      TS,
    );
    expect(snaps.map((s) => s.address)).toEqual(['M1', 'M3']);
    expect(snaps[0]).toMatchObject({ marketCapUsd: null, priceUsd: null });
    expect(snaps[1]).toMatchObject({ marketCapUsd: 4000, priceUsd: null, pairAddress: 'POOL' });
  });
});

describe('mergeSnapshots', () => {
  it('keeps the EIP-55 checksummed casing of an EVM address whichever side brings it', () => {
    const lower = '0x74426b6fb0966c30474a71deb2410bb78c6c7777';
    const checksummed = '0x74426b6FB0966c30474a71Deb2410bb78c6C7777';
    const gt = emptySnapshot('bsc', lower, 1);
    const ds = emptySnapshot('bsc', checksummed, 2);
    expect(mergeSnapshots(gt, ds).address).toBe(checksummed);
    expect(mergeSnapshots(ds, gt).address).toBe(checksummed);
    // a different token never changes identity, and Solana addresses are never re-cased
    expect(mergeSnapshots(gt, emptySnapshot('bsc', '0x1111111111111111111111111111111111111111', 2)).address).toBe(lower);
    const sol = emptySnapshot('solana', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 1);
    expect(mergeSnapshots(sol, { address: sol.address.toLowerCase() }).address).toBe(sol.address);
  });

  const base = (): TokenSnapshot => ({
    ...emptySnapshot('solana', 'Tok111', 1000),
    symbol: 'TOK',
    name: 'Token',
    pairAddress: 'GtPool',
    dex: 'Pump.fun',
    priceUsd: 1,
    fdvUsd: 500,
    liquidityUsd: 100,
    volumeUsd: { m5: 10, m15: 20 },
    txns: { m5: { buys: 1, sells: 2, buyers: 1, sellers: 2 }, m15: { buys: 3, sells: 4, buyers: 3, sellers: 4 } },
    createdAt: 5000,
    links: [{ type: 'twitter', url: 'https://x.com/tok' }],
    security: { mintAuthority: false, freezeAuthority: null, honeypot: 'no', devHoldingPct: null },
    sources: ['geckoterminal'],
  });

  it('non-null extra values win, nulls never erase', () => {
    const merged = mergeSnapshots(base(), {
      symbol: '',
      priceUsd: 2,
      liquidityUsd: null,
      marketCapUsd: 450,
      pairAddress: 'DsPair',
      ts: 2000,
    });
    expect(merged).toMatchObject({
      symbol: 'TOK',
      priceUsd: 2,
      liquidityUsd: 100,
      marketCapUsd: 450,
      fdvUsd: 500,
      pairAddress: 'DsPair',
      ts: 2000,
    });
  });

  it('merges windows and tx counts field by field', () => {
    const merged = mergeSnapshots(base(), {
      volumeUsd: { m5: 11, h1: 99 },
      txns: { m5: { buys: 5, sells: 6, buyers: null, sellers: null }, h1: { buys: 7, sells: 8, buyers: null, sellers: null } },
    });
    expect(merged.volumeUsd).toEqual({ m5: 11, m15: 20, h1: 99 });
    expect(merged.txns).toEqual({
      m5: { buys: 5, sells: 6, buyers: 1, sellers: 2 },
      m15: { buys: 3, sells: 4, buyers: 3, sellers: 4 },
      h1: { buys: 7, sells: 8, buyers: null, sellers: null },
    });
  });

  it('keeps identity, earliest createdAt, unions sources/links, ORs boosted, merges security', () => {
    const merged = mergeSnapshots(base(), {
      chain: 'base',
      address: 'Other',
      createdAt: 9000,
      boosted: true,
      sources: ['dexscreener', 'geckoterminal'],
      links: [
        { type: 'twitter', url: 'https://X.com/tok/' },
        { type: 'website', url: 'https://tok.io' },
      ],
      security: { mintAuthority: null, freezeAuthority: true, honeypot: 'unknown', devHoldingPct: 1.5 },
      holders: 321,
    });
    expect(merged.chain).toBe('solana');
    expect(merged.address).toBe('Tok111');
    expect(merged.createdAt).toBe(5000);
    expect(merged.boosted).toBe(true);
    expect(merged.sources).toEqual(['geckoterminal', 'dexscreener']);
    expect(merged.links).toEqual([
      { type: 'twitter', url: 'https://x.com/tok' },
      { type: 'website', url: 'https://tok.io' },
    ]);
    expect(merged.security).toEqual({ mintAuthority: false, freezeAuthority: true, honeypot: 'no', devHoldingPct: 1.5 });
    expect(merged.holders).toBe(321);
    expect(mergeSnapshots(base(), { createdAt: 100 }).createdAt).toBe(100);
    expect(mergeSnapshots({ ...base(), createdAt: null }, { createdAt: 100 }).createdAt).toBe(100);
  });

  it('treats twitter.com / x.com / www. variants of one profile as the same link', () => {
    const merged = mergeSnapshots(
      { ...base(), links: [{ type: 'twitter', url: 'https://twitter.com/bonk_inu' }] },
      { links: [{ type: 'twitter', url: 'https://www.x.com/bonk_inu' }, { type: 'twitter', url: 'https://x.com/other' }] },
    );
    expect(merged.links.map((l) => l.url)).toEqual(['https://twitter.com/bonk_inu', 'https://x.com/other']);
  });

  it('is pure and deterministic', () => {
    const a = base();
    const snapshotOfA = structuredClone(a);
    const extra: Partial<TokenSnapshot> = { priceUsd: 3, txns: { m5: { buys: 9, sells: null, buyers: null, sellers: null } } };
    const one = mergeSnapshots(a, extra);
    const two = mergeSnapshots(a, extra);
    expect(one).toEqual(two);
    expect(a).toEqual(snapshotOfA);
    expect(one.txns.m5).toEqual({ buys: 9, sells: 2, buyers: 1, sellers: 2 });
  });

  it('keeps provenance with the figure it describes', () => {
    const a = { ...base(), pairAddress: 'PoolA', pairCreatedAt: 1, liquidityUsd: 10, liquiditySource: 'geckoterminal' };
    const b = { pairAddress: 'PoolA', pairCreatedAt: 2, liquidityUsd: 20, liquiditySource: 'dexscreener', liquidityAdjusted: true };
    const merged = mergeSnapshots(a, b);
    expect(merged).toMatchObject({ liquidityUsd: 20, liquiditySource: 'dexscreener', liquidityAdjusted: true, pairCreatedAt: 2 });
    expect(mergeSnapshots(a, { holders: 5 })).toMatchObject({ liquiditySource: 'geckoterminal', pairCreatedAt: 1 });
    expect(mergeSnapshots(base(), {})).not.toHaveProperty('pairCreatedAt');
  });

  it('mergeAcrossPools keeps one pool whole when two observations describe different pools', () => {
    const poolA = {
      ...base(),
      pairAddress: 'PoolA',
      liquidityUsd: 5_000,
      txns: { m5: { buys: 1, sells: 1, buyers: 9, sellers: 9 }, m15: { buys: 3, sells: 3, buyers: 2, sellers: 2 } },
      holders: 120,
    };
    const poolB = {
      ...emptySnapshot('solana', poolA.address, 2000),
      pairAddress: 'PoolB',
      liquidityUsd: 50_000,
      txns: { m5: { buys: 40, sells: 10, buyers: null, sellers: null } },
    };
    const deeper = mergeAcrossPools(poolA, poolB, 'deeper');
    expect(deeper.pairAddress).toBe('PoolB');
    expect(deeper.txns).toEqual({ m5: { buys: 40, sells: 10, buyers: null, sellers: null } });
    expect(deeper.holders).toBe(120); // token-level fact carried over
    expect(deeper.ts).toBe(2000);
    // same pool: plain field-by-field merge
    expect(mergeAcrossPools(poolA, { ...poolB, pairAddress: 'PoolA' }).txns.m5).toEqual({ buys: 40, sells: 10, buyers: 9, sellers: 9 });
    // 'extra' keeps the refresh's pool even when it is thinner
    expect(mergeAcrossPools({ ...poolA, liquidityUsd: 90_000 }, poolB, 'extra').pairAddress).toBe('PoolB');
  });

  it('emptySnapshot has no invented values', () => {
    const e = emptySnapshot('bsc', '0xabc', 42);
    expect(e).toMatchObject({ chain: 'bsc', address: '0xabc', ts: 42, priceUsd: null, holders: null, sources: [], boosted: false });
  });
});
