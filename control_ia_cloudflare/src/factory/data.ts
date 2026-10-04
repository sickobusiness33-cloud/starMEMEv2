// Datos reales para los proyectos de la fábrica. Fuentes públicas y legítimas:
//   - DexScreener API (https://docs.dexscreener.com/api/reference): pares, liquidez, volumen, txns, market cap.
//   - CoinGecko API pública (https://www.coingecko.com/api/documentation): tendencias.
// Los números se devuelven tal cual vienen de la fuente (normalizados de forma, nunca inventados).
// Caché en memoria del isolate (45 s) para respetar los límites de las APIs.

import type { Env } from "../env";

const DEX = "https://api.dexscreener.com";
const CG = "https://api.coingecko.com/api/v3";
const TTL = 45_000;
const cache = new Map<string, { at: number; data: unknown }>();

const coolUntil = new Map<string, number>(); // fuente que nos limitó (429): no se insiste durante 1 min
async function getJson(url: string, ttl = TTL): Promise<any> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  if ((coolUntil.get(new URL(url).host) ?? 0) > Date.now()) throw new Error("Fuente limitada temporalmente");
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "kairo-factory/1.0" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) { if (r.status === 429) coolUntil.set(new URL(url).host, Date.now() + 60_000); throw new Error(`Fuente de datos respondió ${r.status}`); }
  const data = await r.json();
  cache.set(url, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return data;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export interface TokenRow {
  name: string; symbol: string; chain: string; address: string; pair: string; dex: string;
  priceUsd: number | null; change: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  liquidityUsd: number | null; volume24h: number | null; buys24h: number | null; sells24h: number | null;
  marketCap: number | null; fdv: number | null; createdAt: number | null; url: string; icon: string | null;
}

function normPair(p: any, icon: string | null = null): TokenRow {
  return {
    name: String(p.baseToken?.name ?? "").slice(0, 80), symbol: String(p.baseToken?.symbol ?? "").slice(0, 24),
    chain: String(p.chainId ?? ""), address: String(p.baseToken?.address ?? ""), pair: String(p.pairAddress ?? ""), dex: String(p.dexId ?? ""),
    priceUsd: num(p.priceUsd),
    change: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
    liquidityUsd: num(p.liquidity?.usd), volume24h: num(p.volume?.h24),
    buys24h: num(p.txns?.h24?.buys), sells24h: num(p.txns?.h24?.sells),
    marketCap: num(p.marketCap), fdv: num(p.fdv), createdAt: num(p.pairCreatedAt),
    url: typeof p.url === "string" && p.url.startsWith("https://dexscreener.com/") ? p.url : `https://dexscreener.com/${p.chainId}/${p.pairAddress}`,
    icon: p.info?.imageUrl && String(p.info.imageUrl).startsWith("https://") ? String(p.info.imageUrl) : icon,
  };
}

/** Mejor par (más liquidez) de cada token. */
function bestPairs(pairs: any[]): TokenRow[] {
  const by = new Map<string, any>();
  for (const p of pairs || []) {
    const k = `${p.chainId}:${p.baseToken?.address}`;
    const cur = by.get(k);
    if (!cur || (num(p.liquidity?.usd) ?? 0) > (num(cur.liquidity?.usd) ?? 0)) by.set(k, p);
  }
  return [...by.values()].map((p) => normPair(p));
}

/** Datos de pares para una lista de tokens (agrupa por cadena, máx. 30 por llamada). */
async function enrich(list: { chainId: string; tokenAddress: string }[]): Promise<TokenRow[]> {
  const byChain = new Map<string, string[]>();
  for (const t of list) if (t.chainId && t.tokenAddress) {
    const arr = byChain.get(t.chainId) ?? [];
    if (!arr.includes(t.tokenAddress) && arr.length < 30) arr.push(t.tokenAddress);
    byChain.set(t.chainId, arr);
  }
  const out: TokenRow[] = [];
  for (const [chain, addrs] of [...byChain].slice(0, 4)) {
    const pairs = await getJson(`${DEX}/tokens/v1/${encodeURIComponent(chain)}/${addrs.map(encodeURIComponent).join(",")}`).catch(() => []);
    out.push(...bestPairs(Array.isArray(pairs) ? pairs : []));
  }
  return out;
}

// ---- Respaldo: GeckoTerminal (API pública de CoinGecko para DEX). DexScreener limita (429) las IP de Cloudflare.
const GT = "https://api.geckoterminal.com/api/v2";
function gtRows(d: any): TokenRow[] {
  const toks = new Map<string, any>((d?.included ?? []).filter((x: any) => x.type === "token").map((x: any) => [x.id, x.attributes]));
  const out: TokenRow[] = [];
  for (const p of d?.data ?? []) {
    const a = p.attributes ?? {}, rel = p.relationships ?? {};
    const t = toks.get(rel.base_token?.data?.id) ?? {};
    const chain = String(rel.network?.data?.id ?? String(p.id ?? "").split("_")[0] ?? "");
    const pc = a.price_change_percentage ?? {}, tx = a.transactions?.h24 ?? {};
    out.push({
      name: String(t.name ?? a.name ?? "").slice(0, 80), symbol: String(t.symbol ?? String(a.name ?? "").split(" / ")[0]).slice(0, 24), chain,
      address: String(t.address ?? String(rel.base_token?.data?.id ?? "").split("_").slice(1).join("_")), pair: String(a.address ?? ""), dex: String(rel.dex?.data?.id ?? ""),
      priceUsd: num(a.base_token_price_usd), change: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) },
      liquidityUsd: num(a.reserve_in_usd), volume24h: num(a.volume_usd?.h24), buys24h: num(tx.buys), sells24h: num(tx.sells),
      marketCap: num(a.market_cap_usd), fdv: num(a.fdv_usd), createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
      url: `https://www.geckoterminal.com/${encodeURIComponent(chain)}/pools/${encodeURIComponent(String(a.address ?? ""))}`,
      icon: typeof t.image_url === "string" && t.image_url.startsWith("https://") ? t.image_url : null,
    });
  }
  // Un token, una fila (la de más liquidez)
  const by = new Map<string, TokenRow>();
  for (const r of out) { const k = `${r.chain}:${r.address}`; if (!by.has(k) || (r.liquidityUsd ?? 0) > (by.get(k)!.liquidityUsd ?? 0)) by.set(k, r); }
  return [...by.values()];
}
const gt = (path: string) => getJson(`${GT}${path}${path.includes("?") ? "&" : "?"}include=base_token,dex`).then(gtRows);
/** Intenta DexScreener; si falla o viene vacío, GeckoTerminal. Se indica la fuente real usada. */
export let lastSource = "DexScreener";
async function withFallback(primary: () => Promise<TokenRow[]>, backup: () => Promise<TokenRow[]>): Promise<TokenRow[]> {
  try { const r = await primary(); if (r.length) { lastSource = "DexScreener"; return r; } } catch { /* respaldo */ }
  const r = await backup(); lastSource = "GeckoTerminal (CoinGecko)"; return r;
}

export async function cryptoTrending(): Promise<TokenRow[]> {
  const rows = await withFallback(async () => enrich(await getJson(`${DEX}/token-boosts/top/v1`).then((b) => (Array.isArray(b) ? b : []))), () => gt("/networks/trending_pools?page=1"));
  return rows.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, 30);
}

export async function cryptoNew(): Promise<TokenRow[]> {
  const rows = await withFallback(async () => enrich(await getJson(`${DEX}/token-profiles/latest/v1`).then((b) => (Array.isArray(b) ? b : []))), () => gt("/networks/new_pools?page=1"));
  return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 30);
}

export async function cryptoSearch(q: string): Promise<TokenRow[]> {
  const rows = await withFallback(async () => bestPairs((await getJson(`${DEX}/latest/dex/search?q=${encodeURIComponent(q.slice(0, 64))}`))?.pairs ?? []), () => gt(`/search/pools?query=${encodeURIComponent(q.slice(0, 64))}`));
  return rows.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, 20);
}

export async function cryptoToken(chain: string, address: string): Promise<TokenRow | null> {
  const rows = await withFallback(async () => bestPairs(await getJson(`${DEX}/tokens/v1/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`).then((p) => (Array.isArray(p) ? p : []))),
    () => gt(`/networks/${encodeURIComponent(chain)}/tokens/${encodeURIComponent(address)}/pools?page=1`));
  return rows[0] ?? null;
}

export async function cryptoMarket(): Promise<{ coins: any[] }> {
  const d = await getJson(`${CG}/search/trending`, 120_000);
  const coins = (d?.coins ?? []).slice(0, 15).map((c: any) => ({
    name: String(c.item?.name ?? ""), symbol: String(c.item?.symbol ?? ""), rank: num(c.item?.market_cap_rank),
    priceUsd: num(c.item?.data?.price), change24h: num(c.item?.data?.price_change_percentage_24h?.usd),
    marketCap: c.item?.data?.market_cap ?? null, volume: c.item?.data?.total_volume ?? null,
    image: typeof c.item?.small === "string" && c.item.small.startsWith("https://") ? c.item.small : null,
    url: `https://www.coingecko.com/en/coins/${encodeURIComponent(c.item?.id ?? "")}`,
  }));
  return { coins };
}

/** Endpoints de datos que un proyecto puede usar (la QA los comprueba antes de publicar). */
export const DATA_ENDPOINTS: Record<string, { path: string; source: string; run: (env: Env, q?: URLSearchParams) => Promise<unknown> }> = {
  "crypto.trending": { path: "/fx/data/crypto/trending", source: "DexScreener (token boosts + pares)", run: () => cryptoTrending() },
  "crypto.new": { path: "/fx/data/crypto/new", source: "DexScreener (perfiles recientes + pares)", run: () => cryptoNew() },
  "crypto.search": { path: "/fx/data/crypto/search", source: "DexScreener (búsqueda)", run: (_e, q) => cryptoSearch(q?.get("q") || "sol") },
  "crypto.market": { path: "/fx/data/crypto/market", source: "CoinGecko (trending)", run: () => cryptoMarket() },
};

/** Comprueba que un endpoint devuelve datos reales con números válidos. */
export async function probeEndpoint(env: Env, key: string): Promise<{ ok: boolean; detail: string }> {
  const ep = DATA_ENDPOINTS[key];
  if (!ep) return { ok: false, detail: `Endpoint desconocido: ${key}` };
  if (env.AI_MODE === "mock") return { ok: true, detail: `${key}: simulado en tests` };
  try {
    const d: any = await ep.run(env, new URLSearchParams({ q: "sol" }));
    const rows = Array.isArray(d) ? d : d?.coins ?? [];
    const valid = rows.filter((r: any) => r && (r.priceUsd === null || Number.isFinite(r.priceUsd)));
    return valid.length ? { ok: true, detail: `${key}: ${valid.length} filas de ${ep.source}` } : { ok: false, detail: `${key}: la fuente no devolvió filas` };
  } catch (err) {
    return { ok: false, detail: `${key}: ${(err as Error).message}` };
  }
}
