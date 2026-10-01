/*
 * pump.fun (frontend-api-v3.pump.fun): the newest Solana launches, seconds
 * after creation. pump.fun reports market cap but no liquidity, volume or
 * trade counts; the DexScreener refresh fills those in.
 */
import type { TokenSnapshot } from '../../../shared/types.js';
import { fetchJson } from '../net/http.js';
import { asArray, asRecord, compactLinks, emptySnapshot, makeLink, toEpochMs, toHttpUrl, toNum, toStr } from './merge.js';

const PUMP_API = 'https://frontend-api-v3.pump.fun';
const MAX_LIMIT = 50;
const NEWEST_TTL_MS = 10_000;

export async function pumpNewest(limit = 40): Promise<TokenSnapshot[]> {
  const n = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
  const url = `${PUMP_API}/coins?offset=0&limit=${n}&sort=created_timestamp&order=DESC&includeNsfw=false`;
  const json = await fetchJson(url, { limiter: 'pumpfun', cacheTtlMs: NEWEST_TTL_MS });
  return parsePumpCoins(json);
}

/** Coins (array, or `{ coins }`) → Solana snapshots. Banned coins are skipped. */
export function parsePumpCoins(json: unknown, ts: number = Date.now()): TokenSnapshot[] {
  const coins = Array.isArray(json) ? json : asArray(asRecord(json).coins);
  const out: TokenSnapshot[] = [];
  for (const raw of coins) {
    const coin = asRecord(raw);
    const mint = toStr(coin.mint);
    if (!mint || coin.is_banned === true) continue;
    const symbol = toStr(coin.symbol) ?? '';
    const marketCapUsd = toNum(coin.usd_market_cap) ?? toNum(coin.market_cap_usd);
    out.push({
      ...emptySnapshot('solana', mint, ts),
      symbol,
      name: toStr(coin.name) ?? symbol,
      pairAddress: poolAddress(coin),
      dex: 'pump.fun',
      priceUsd: priceFromMarketCap(marketCapUsd, coin),
      marketCapUsd,
      createdAt: toEpochMs(coin.created_timestamp),
      imageUrl: toHttpUrl(coin.image_uri),
      links: compactLinks([
        makeLink('twitter', coin.twitter),
        makeLink('telegram', coin.telegram),
        makeLink('website', coin.website),
      ]),
      sources: ['pumpfun'],
    });
  }
  return out;
}

/** Trading happens on the bonding curve until the coin graduates to its AMM pool. */
function poolAddress(coin: Record<string, unknown>): string | null {
  if (coin.complete === true) {
    return toStr(coin.pool_address) ?? toStr(coin.pump_swap_pool) ?? toStr(coin.raydium_pool);
  }
  return toStr(coin.bonding_curve);
}

/** pump.fun market cap = price × total supply, so price = market cap / (raw supply / 10^decimals). */
function priceFromMarketCap(marketCapUsd: number | null, coin: Record<string, unknown>): number | null {
  const rawSupply = toNum(coin.total_supply);
  const decimals = toNum(coin.base_decimals);
  if (marketCapUsd === null || rawSupply === null || decimals === null || rawSupply <= 0) return null;
  return marketCapUsd / (rawSupply / 10 ** decimals);
}
