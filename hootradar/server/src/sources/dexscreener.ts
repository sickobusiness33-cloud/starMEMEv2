/*
 * DexScreener (api.dexscreener.com): batch market-data refresh, symbol search
 * and the latest token profiles / paid boosts used as a discovery feed.
 */
import type { ChainId, TokenLink, TokenSnapshot, TxCounts } from '../../../shared/types.js';
import { errMsg, logger } from '../log.js';
import { fetchJson, laneLimiter, type CallOpts } from '../net/http.js';
import {
  addressKey,
  asArray,
  asRecord,
  compactLinks,
  emptySnapshot,
  makeLink,
  mapWindows,
  mergeLinks,
  toEpochMs,
  toHttpUrl,
  toNum,
  toStr,
} from './merge.js';

const log = logger('dexscreener');

const DS_API = 'https://api.dexscreener.com';
const BATCH_SIZE = 30;
const SEARCH_TTL_MS = 30_000;
/** every chain's discover() reads the same two feeds; share one response */
const LISTINGS_TTL_MS = 20_000;
const DS_CDN_IMAGES = 'https://cdn.dexscreener.com/cms/images/';
const DS_ICON_PARAMS = '?width=64&height=64&fit=crop&quality=95&format=auto';

export interface DsListing {
  dsChainId: string;
  address: string;
  boosted: boolean;
  links: TokenLink[];
  imageUrl: string | null;
}

/* ───────────────────────────── fetchers ───────────────────────────── */

/**
 * Market data for known tokens, in batches of 30. One snapshot per requested
 * token that DexScreener lists as the BASE token of at least one pair (its most
 * liquid pair). Throws only when every batch failed.
 */
export async function dsTokens(
  dsChainId: string,
  chain: ChainId,
  addresses: string[],
  o: CallOpts = {},
): Promise<TokenSnapshot[]> {
  const wanted = new Map<string, string>();
  for (const a of addresses) {
    const trimmed = a.trim();
    if (trimmed) wanted.set(addressKey(trimmed), trimmed);
  }
  const batches = chunk([...wanted.values()], BATCH_SIZE);
  const results = await Promise.allSettled(
    batches.map((batch) =>
      fetchJson(`${DS_API}/tokens/v1/${encodeURIComponent(dsChainId)}/${batch.map(encodeURIComponent).join(',')}`, {
        ...requestOpts(o),
      }),
    ),
  );

  // a pair comes back for its base AND its quote token, so one token can appear in several batches
  const byToken = new Map<string, TokenSnapshot>();
  const failures: string[] = [];
  for (const r of results) {
    if (r.status === 'rejected') {
      failures.push(errMsg(r.reason));
      continue;
    }
    for (const snap of parseDsPairs(r.value, chain)) {
      const key = addressKey(snap.address);
      const prev = byToken.get(key);
      if (wanted.has(key) && (!prev || (snap.liquidityUsd ?? -1) > (prev.liquidityUsd ?? -1))) byToken.set(key, snap);
    }
  }
  if (batches.length > 0 && failures.length === batches.length) {
    throw new Error(`dexscreener tokens failed: ${failures[0]}`);
  }
  if (failures.length > 0) log.warn('some token batches failed', { chain, failed: failures.length, error: failures[0] });
  return [...byToken.values()];
}

/** Free-text search across every chain DexScreener covers; callers filter by chain. */
export async function dsSearch(query: string, o: CallOpts = {}): Promise<TokenSnapshot[]> {
  const q = query.trim();
  if (!q) return [];
  const json = await fetchJson(`${DS_API}/latest/dex/search?q=${encodeURIComponent(q)}`, {
    ...requestOpts(o),
    cacheTtlMs: SEARCH_TTL_MS,
  });
  return parseDsPairs(json, null);
}

function requestOpts(o: CallOpts) {
  return {
    limiter: laneLimiter('dexscreener', o.lane),
    signal: o.signal,
    maxQueueMs: o.maxQueueMs,
    maxPauseWaitMs: o.maxPauseWaitMs,
  };
}

/** Latest token profiles and boosts, merged per token. Boosts are paid promotion → `boosted: true`. */
export async function dsLatestListings(o: Pick<CallOpts, 'signal' | 'maxQueueMs'> = {}): Promise<DsListing[]> {
  const opts = { limiter: 'dexscreener-meta', cacheTtlMs: LISTINGS_TTL_MS, signal: o.signal, maxQueueMs: o.maxQueueMs };
  const [profiles, boosts] = await Promise.allSettled([
    fetchJson(`${DS_API}/token-profiles/latest/v1`, opts),
    fetchJson(`${DS_API}/token-boosts/latest/v1`, opts),
  ]);
  if (profiles.status === 'rejected' && boosts.status === 'rejected') {
    throw new Error(`dexscreener listings failed: ${errMsg(profiles.reason)}`);
  }
  const lists: DsListing[][] = [];
  if (profiles.status === 'fulfilled') lists.push(parseDsListings(profiles.value, false));
  else log.warn('token profiles failed', { error: errMsg(profiles.reason) });
  if (boosts.status === 'fulfilled') lists.push(parseDsListings(boosts.value, true));
  else log.warn('token boosts failed', { error: errMsg(boosts.reason) });
  return mergeListings(lists.flat());
}

/* ───────────────────────────── parsers ───────────────────────────── */

/**
 * Pairs (a `tokens/v1` array or a search `{ pairs }` document) → one snapshot
 * per (chainId, base token), built from the most liquid pair. `chain` null
 * means "use each pair's chainId" (search across chains).
 */
export function parseDsPairs(json: unknown, chain: ChainId | null, ts: number = Date.now()): TokenSnapshot[] {
  const pairs = Array.isArray(json) ? json : asArray(asRecord(json).pairs);
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const raw of pairs) {
    const pair = asRecord(raw);
    const chainId = toStr(pair.chainId);
    const address = toStr(asRecord(pair.baseToken).address);
    if (!chainId || !address) continue;
    const key = `${chainId}:${addressKey(address)}`;
    const group = groups.get(key);
    if (group) group.push(pair);
    else groups.set(key, [pair]);
  }
  return [...groups.values()].map((group) => tokenFromPairs(group, chain, ts));
}

function tokenFromPairs(pairs: Array<Record<string, unknown>>, chain: ChainId | null, ts: number): TokenSnapshot {
  const best = pairs.reduce((a, b) => ((pairLiquidity(b) ?? -1) > (pairLiquidity(a) ?? -1) ? b : a));
  const base = asRecord(best.baseToken);
  const address = toStr(base.address) ?? '';
  const symbol = toStr(base.symbol) ?? '';
  const info = asRecord(best.info ?? pairs.find((p) => p.info)?.info);
  const liquidity = pairLiquidityInfo(best);
  return {
    ...emptySnapshot(chain ?? (toStr(best.chainId) as ChainId), address, ts),
    symbol,
    name: toStr(base.name) ?? symbol,
    pairAddress: toStr(best.pairAddress),
    dex: toStr(best.dexId),
    pairCreatedAt: toEpochMs(best.pairCreatedAt),
    liquiditySource: liquidity.usd !== null ? 'dexscreener' : null,
    liquidityAdjusted: liquidity.adjusted,
    priceUsd: toNum(best.priceUsd),
    marketCapUsd: toNum(best.marketCap),
    fdvUsd: toNum(best.fdv),
    liquidityUsd: liquidity.usd,
    volumeUsd: mapWindows(best.volume, toNum),
    priceChangePct: mapWindows(best.priceChange, toNum),
    txns: mapWindows(best.txns, readTxCounts),
    createdAt: earliestPairCreation(pairs),
    imageUrl: toHttpUrl(info.imageUrl),
    links: readInfoLinks(info),
    sources: ['dexscreener'],
    boosted: pairs.some((p) => (toNum(asRecord(p.boosts).active) ?? 0) > 0),
  };
}

/**
 * A pool's reported liquidity values both reserves at the pool's own price. When
 * that price is manipulated (a worthless token quoted against a few USDC) or the
 * pool is single-sided (a launch pool holding almost only the new token), the
 * figure can be thousands of times what a seller could ever take out. Real pools
 * report 1-3x twice their quote reserve; above 10x we keep the quote-backed value,
 * twice the quote reserve priced in USD (priceUsd / priceNative = quote price).
 */
const MAX_LIQUIDITY_TO_QUOTE_BACKING = 10;

export function pairLiquidity(pair: Record<string, unknown>): number | null {
  return pairLiquidityInfo(pair).usd;
}

/**
 * The liquidity figure and whether it is the quote-backed replacement. The two
 * series are not comparable: growth across a switch (a 4% change in reserves that
 * crosses the 10x line reads as +920%) is never measured.
 */
export function pairLiquidityInfo(pair: Record<string, unknown>): { usd: number | null; adjusted: boolean } {
  const liquidity = asRecord(pair.liquidity);
  const reported = toNum(liquidity.usd);
  if (reported === null) return { usd: null, adjusted: false };
  const quoteReserve = toNum(liquidity.quote);
  const priceUsd = toNum(pair.priceUsd);
  const priceNative = toNum(pair.priceNative);
  if (quoteReserve === null || priceUsd === null || priceNative === null || priceNative <= 0) {
    return { usd: reported, adjusted: false };
  }
  const backed = 2 * quoteReserve * (priceUsd / priceNative);
  if (!Number.isFinite(backed) || reported <= MAX_LIQUIDITY_TO_QUOTE_BACKING * backed) return { usd: reported, adjusted: false };
  return { usd: Math.round(backed * 100) / 100, adjusted: true };
}

/** DexScreener has no unique-wallet counts. */
function readTxCounts(v: unknown): TxCounts {
  const t = asRecord(v);
  return { buys: toNum(t.buys), sells: toNum(t.sells), buyers: null, sellers: null };
}

/** Earliest pair creation across the token's pairs approximates its launch time. */
function earliestPairCreation(pairs: Array<Record<string, unknown>>): number | null {
  let min: number | null = null;
  for (const p of pairs) {
    const at = toEpochMs(p.pairCreatedAt);
    if (at !== null && (min === null || at < min)) min = at;
  }
  return min;
}

function readInfoLinks(info: Record<string, unknown>): TokenLink[] {
  return compactLinks([
    ...asArray(info.websites).map((w) => makeLink('website', asRecord(w).url, toStr(asRecord(w).label))),
    ...asArray(info.socials).map((s) => makeLink(toStr(asRecord(s).type), asRecord(s).url)),
  ]);
}

/** `token-profiles/latest/v1` or `token-boosts/latest/v1` → listings (deduped per token). */
export function parseDsListings(json: unknown, boosted = false): DsListing[] {
  const listings = asArray(json).flatMap((raw): DsListing[] => {
    const item = asRecord(raw);
    const dsChainId = toStr(item.chainId);
    const address = toStr(item.tokenAddress);
    if (!dsChainId || !address) return [];
    const links = compactLinks(
      asArray(item.links).map((l) => {
        const link = asRecord(l);
        return makeLink(toStr(link.type) ?? toStr(link.label), link.url, toStr(link.label));
      }),
    );
    return [{ dsChainId, address, boosted, links, imageUrl: iconUrl(item.icon) }];
  });
  return mergeListings(listings);
}

/** Boost feeds give a bare CDN image id instead of a URL. */
function iconUrl(v: unknown): string | null {
  const url = toHttpUrl(v);
  if (url) return url;
  const id = toStr(v);
  return id !== null && /^[A-Za-z0-9_-]+$/.test(id) ? `${DS_CDN_IMAGES}${id}${DS_ICON_PARAMS}` : null;
}

function mergeListings(listings: DsListing[]): DsListing[] {
  const byToken = new Map<string, DsListing>();
  for (const l of listings) {
    const key = `${l.dsChainId}:${addressKey(l.address)}`;
    const prev = byToken.get(key);
    byToken.set(
      key,
      prev
        ? {
            ...prev,
            boosted: prev.boosted || l.boosted,
            links: mergeLinks(prev.links, l.links),
            imageUrl: prev.imageUrl ?? l.imageUrl,
          }
        : l,
    );
  }
  return [...byToken.values()];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
