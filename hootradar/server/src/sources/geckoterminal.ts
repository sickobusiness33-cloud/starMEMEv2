/*
 * GeckoTerminal (api.geckoterminal.com/api/v2): new-pool discovery, token info
 * (holders, concentration, security flags) and per-token pool lookup.
 * JSON:API documents; every numeric attribute arrives as a string.
 */
import type { ChainId, TokenLink, TokenSecurity, TokenSnapshot, TxCounts } from '../../../shared/types.js';
import type { TokenEnrichment } from '../chains/types.js';
import { fetchJson, HttpError, laneLimiter, type CallOpts } from '../net/http.js';
import {
  addressKey,
  asArray,
  asRecord,
  compactLinks,
  emptySnapshot,
  makeLink,
  mapWindows,
  toEpochMs,
  toHttpUrl,
  toNum,
  toStr,
} from './merge.js';

const GT_API = 'https://api.geckoterminal.com/api/v2';
const GT_HEADERS = { accept: 'application/json;version=20230203' };
const PROVIDER = 'geckoterminal';
const INCLUDE = 'include=base_token,quote_token,dex';
const TOKEN_INFO_TTL_MS = 3 * 60_000;
const TOKEN_POOLS_TTL_MS = 30_000;
/** GeckoTerminal does not know the address: asked again only after this (Radar queries can be random) */
const NOT_FOUND_TTL_MS = 5 * 60_000;

/**
 * Well-known quote assets. A pool against one of these is a market for the
 * other token. Addresses decide first; symbols only break ties, because
 * launchpads happily mint tokens called "SOL".
 */
const QUOTE_ADDRESSES = new Set(
  [
    // Solana: native SOL, wSOL, USDC, USDT
    '11111111111111111111111111111111',
    'So11111111111111111111111111111111111111112',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    // EVM native-asset placeholder used by Uniswap v4 pools
    '0x0000000000000000000000000000000000000000',
    // Ethereum: WETH, USDC, USDT
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    // Base: WETH, USDC, USDbC
    '0x4200000000000000000000000000000000000006',
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
    // BSC: WBNB, USDT, USDC, BUSD
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    '0x55d398326f99059fF775485246999027B3197955',
    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  ].map(addressKey),
);
const QUOTE_SYMBOLS = new Set(['SOL', 'WSOL', 'ETH', 'WETH', 'BNB', 'WBNB', 'USDC', 'USDT']);

/* ───────────────────────────── fetchers ───────────────────────────── */

/** Newest pools on a network, one snapshot per new token (its most liquid new pool). */
export async function gtNewPools(network: string, chain: ChainId, o: CallOpts = {}): Promise<TokenSnapshot[]> {
  const url = `${GT_API}/networks/${enc(network)}/new_pools?${INCLUDE}&page=1`;
  const json = await fetchJson(url, { ...requestOpts(o), headers: GT_HEADERS });
  return parseGtPools(json, chain);
}

/** Holders, top-10 concentration, security flags and socials. Null when GeckoTerminal does not know the token. */
export async function gtTokenInfo(network: string, address: string, o: CallOpts = {}): Promise<TokenEnrichment | null> {
  const url = `${GT_API}/networks/${enc(network)}/tokens/${enc(address)}/info`;
  const json = await fetchOrNullOn404(url, TOKEN_INFO_TTL_MS, o);
  return json === null ? null : parseGtTokenInfo(json);
}

/** The token's most liquid pool as a snapshot (GeckoTerminal adds unique buyers/sellers and m15/m30 windows). */
export async function gtTokenTopPool(
  network: string,
  chain: ChainId,
  address: string,
  o: CallOpts = {},
): Promise<TokenSnapshot | null> {
  const url = `${GT_API}/networks/${enc(network)}/tokens/${enc(address)}/pools?${INCLUDE}&page=1`;
  const json = await fetchOrNullOn404(url, TOKEN_POOLS_TTL_MS, o);
  return json === null ? null : parseGtTokenPools(json, chain, address);
}

function requestOpts(o: CallOpts) {
  return {
    limiter: laneLimiter(PROVIDER, o.lane),
    signal: o.signal,
    maxQueueMs: o.maxQueueMs,
    maxPauseWaitMs: o.maxPauseWaitMs,
  };
}

async function fetchOrNullOn404(url: string, cacheTtlMs: number, o: CallOpts): Promise<unknown> {
  try {
    return await fetchJson(url, { ...requestOpts(o), headers: GT_HEADERS, cacheTtlMs, notFoundTtlMs: NOT_FOUND_TTL_MS });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

function enc(s: string): string {
  return encodeURIComponent(s.trim());
}

/* ───────────────────────────── parsers ───────────────────────────── */

interface TokenSide {
  address: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
}

interface PoolSides {
  pool: Record<string, unknown>;
  attrs: Record<string, unknown>;
  base: TokenSide;
  quote: TokenSide;
  dex: string | null;
}

type Included = Map<string, Record<string, unknown>>;

/**
 * Pools from `networks/{net}/new_pools` → one snapshot per token, keeping the
 * most liquid pool when a token launched several. Pools that pair two quote
 * assets (e.g. SOL/USDC) are skipped.
 */
export function parseGtPools(json: unknown, chain: ChainId, ts: number = Date.now()): TokenSnapshot[] {
  const doc = asRecord(json);
  const included = indexIncluded(doc.included);
  const byToken = new Map<string, TokenSnapshot>();
  for (const raw of asArray(doc.data)) {
    const sides = readPool(raw, included);
    if (!sides) continue;
    const side = chooseTokenSide(sides.base, sides.quote);
    if (!side) continue;
    keepMostLiquid(byToken, poolSnapshot(sides, side, chain, ts));
  }
  return [...byToken.values()];
}

/**
 * Pools from `networks/{net}/tokens/{address}/pools` → the most liquid pool in
 * which `address` is the base token (falling back to pools where it is the quote).
 */
export function parseGtTokenPools(
  json: unknown,
  chain: ChainId,
  address: string,
  ts: number = Date.now(),
): TokenSnapshot | null {
  const doc = asRecord(json);
  const included = indexIncluded(doc.included);
  const wanted = addressKey(address);
  const asBase: TokenSnapshot[] = [];
  const asQuote: TokenSnapshot[] = [];
  for (const raw of asArray(doc.data)) {
    const sides = readPool(raw, included);
    if (!sides) continue;
    const side = addressKey(sides.base.address) === wanted ? 'base' : addressKey(sides.quote.address) === wanted ? 'quote' : null;
    if (!side) continue;
    const snap = poolSnapshot(sides, side, chain, ts);
    // this endpoint reports the requested token's own USD price in `token_price_usd`
    snap.priceUsd = toNum(sides.attrs.token_price_usd) ?? snap.priceUsd;
    (side === 'base' ? asBase : asQuote).push(snap);
  }
  return mostLiquid(asBase) ?? mostLiquid(asQuote);
}

/**
 * A share of supply in percent, or null when it cannot be one. GeckoTerminal sometimes
 * reports a top-10 share a little over 100 with a negative remainder (live: top_10
 * "101.1462", rest "-1.8852" for a 37-holder pump.fun token) when its supply figure lags
 * burns or mints. Up to SUPPLY_PCT_OVERSHOOT points over is that lag and reads as 100;
 * anything further outside 0-100 is not a share of supply and is unknown.
 */
const SUPPLY_PCT_OVERSHOOT = 5;
export function supplyPct(v: unknown): number | null {
  const n = toNum(v);
  if (n == null || n < 0 || n > 100 + SUPPLY_PCT_OVERSHOOT) return null;
  return Math.min(n, 100);
}

export function parseGtTokenInfo(json: unknown): TokenEnrichment | null {
  const data = asRecord(asRecord(json).data);
  if (!('attributes' in data)) return null;
  const a = asRecord(data.attributes);
  const holders = asRecord(a.holders);
  return {
    holders: toNum(holders.count),
    top10HolderPct: supplyPct(asRecord(holders.distribution_percentage).top_10),
    security: readSecurity(a),
    imageUrl: toHttpUrl(a.image_url),
    links: readInfoLinks(a),
  };
}

function readSecurity(a: Record<string, unknown>): TokenSecurity | null {
  const security: TokenSecurity = {
    mintAuthority: yesNo(a.mint_authority),
    freezeAuthority: yesNo(a.freeze_authority),
    honeypot: a.is_honeypot === 'yes' ? 'yes' : a.is_honeypot === 'no' ? 'no' : 'unknown',
    devHoldingPct: supplyPct(a.developer_holding_percentage),
  };
  const known =
    security.mintAuthority !== null ||
    security.freezeAuthority !== null ||
    security.honeypot !== 'unknown' ||
    security.devHoldingPct !== null;
  return known ? security : null;
}

function yesNo(v: unknown): boolean | null {
  if (v === 'yes' || v === true) return true;
  if (v === 'no' || v === false) return false;
  return null;
}

function readInfoLinks(a: Record<string, unknown>): TokenLink[] {
  const handle = (v: unknown): string | null => {
    const s = toStr(v)?.replace(/^@/, '') ?? null;
    return s !== null && /^[A-Za-z0-9_]{1,64}$/.test(s) ? s : null;
  };
  const twitter = handle(a.twitter_handle);
  const telegram = handle(a.telegram_handle);
  return compactLinks([
    ...asArray(a.websites).map((url) => makeLink('website', url)),
    twitter ? makeLink('twitter', `https://x.com/${twitter}`) : null,
    telegram ? makeLink('telegram', `https://t.me/${telegram}`) : null,
    makeLink('discord', a.discord_url),
  ]);
}

function indexIncluded(raw: unknown): Included {
  const out: Included = new Map();
  for (const item of asArray(raw)) {
    const rec = asRecord(item);
    const id = toStr(rec.id);
    if (id) out.set(id, rec);
  }
  return out;
}

function relationshipId(pool: Record<string, unknown>, name: string): string | null {
  return toStr(asRecord(asRecord(asRecord(pool.relationships)[name]).data).id);
}

function readPool(raw: unknown, included: Included): PoolSides | null {
  const pool = asRecord(raw);
  const attrs = asRecord(pool.attributes);
  const baseId = relationshipId(pool, 'base_token');
  const quoteId = relationshipId(pool, 'quote_token');
  if (!baseId || !quoteId) return null;
  const [baseSymbol, quoteSymbol] = symbolsFromPoolName(toStr(attrs.name));
  const base = readTokenSide(baseId, included, baseSymbol);
  const quote = readTokenSide(quoteId, included, quoteSymbol);
  if (!base || !quote) return null;
  const dexId = relationshipId(pool, 'dex');
  const dexName = dexId ? toStr(asRecord(included.get(dexId)?.attributes).name) : null;
  return { pool, attrs, base, quote, dex: dexName ?? dexId };
}

/** Token ids are "{network}_{address}"; addresses never contain "_". */
function readTokenSide(id: string, included: Included, poolNameSymbol: string | null): TokenSide | null {
  const attrs = asRecord(included.get(id)?.attributes);
  const address = toStr(attrs.address) ?? toStr(id.slice(id.lastIndexOf('_') + 1));
  if (!address) return null;
  const symbol = toStr(attrs.symbol) ?? poolNameSymbol ?? '';
  return { address, symbol, name: toStr(attrs.name) ?? symbol, imageUrl: toHttpUrl(attrs.image_url) };
}

/** "BHD / ETH 1%" → ["BHD", "ETH"] */
function symbolsFromPoolName(name: string | null): [string | null, string | null] {
  if (!name) return [null, null];
  const [base, quote] = name.split(' / ');
  const quoteSymbol = quote?.replace(/\s+\d+(\.\d+)?%$/, '');
  return [toStr(base), toStr(quoteSymbol)];
}

function isQuoteAddress(side: TokenSide): boolean {
  return QUOTE_ADDRESSES.has(addressKey(side.address));
}

function isQuoteSymbol(side: TokenSide): boolean {
  return QUOTE_SYMBOLS.has(side.symbol.toUpperCase());
}

/** Which side of the pool is "the token": the non-quote asset. Null when both sides are quote assets. */
function chooseTokenSide(base: TokenSide, quote: TokenSide): 'base' | 'quote' | null {
  const baseQ = isQuoteAddress(base);
  const quoteQ = isQuoteAddress(quote);
  if (baseQ && quoteQ) return null;
  if (baseQ !== quoteQ) return baseQ ? 'quote' : 'base';
  return isQuoteSymbol(base) && !isQuoteSymbol(quote) ? 'quote' : 'base';
}

/**
 * Pool attributes describe the base token. When the token is the quote side,
 * base-token valuations (FDV, market cap, price change) are dropped and the
 * trade directions are swapped: buying the base is selling the token.
 */
function poolSnapshot(sides: PoolSides, side: 'base' | 'quote', chain: ChainId, ts: number): TokenSnapshot {
  const { attrs } = sides;
  const inverted = side === 'quote';
  const token = inverted ? sides.quote : sides.base;
  const liquidityUsd = toNum(attrs.reserve_in_usd);
  const poolCreatedAt = toEpochMs(attrs.pool_created_at);
  return {
    ...emptySnapshot(chain, token.address, ts),
    symbol: token.symbol,
    name: token.name,
    pairAddress: toStr(attrs.address),
    dex: sides.dex,
    pairCreatedAt: poolCreatedAt,
    liquiditySource: liquidityUsd !== null ? PROVIDER : null,
    priceUsd: toNum(inverted ? attrs.quote_token_price_usd : attrs.base_token_price_usd),
    marketCapUsd: inverted ? null : toNum(attrs.market_cap_usd),
    fdvUsd: inverted ? null : toNum(attrs.fdv_usd),
    liquidityUsd,
    volumeUsd: mapWindows(attrs.volume_usd, toNum),
    priceChangePct: inverted ? {} : mapWindows(attrs.price_change_percentage, toNum),
    txns: mapWindows(attrs.transactions, (v) => readTxCounts(v, inverted)),
    createdAt: poolCreatedAt,
    imageUrl: token.imageUrl,
    sources: ['geckoterminal'],
  };
}

function readTxCounts(v: unknown, inverted: boolean): TxCounts {
  const t = asRecord(v);
  const buys = toNum(t.buys);
  const sells = toNum(t.sells);
  const buyers = toNum(t.buyers);
  const sellers = toNum(t.sellers);
  return inverted
    ? { buys: sells, sells: buys, buyers: sellers, sellers: buyers }
    : { buys, sells, buyers, sellers };
}

function keepMostLiquid(byToken: Map<string, TokenSnapshot>, snap: TokenSnapshot): void {
  const key = addressKey(snap.address);
  const current = byToken.get(key);
  if (!current || (snap.liquidityUsd ?? -1) > (current.liquidityUsd ?? -1)) byToken.set(key, snap);
}

function mostLiquid(snaps: TokenSnapshot[]): TokenSnapshot | null {
  let best: TokenSnapshot | null = null;
  for (const s of snaps) {
    if (!best || (s.liquidityUsd ?? -1) > (best.liquidityUsd ?? -1)) best = s;
  }
  return best;
}
