/*
 * Building and merging TokenSnapshots, plus the small field parsers every
 * provider module shares. Unknown is always null — never 0, never a guess.
 */
import type {
  ChainId,
  TimeWindow,
  TokenLink,
  TokenSecurity,
  TokenSnapshot,
  TxCounts,
} from '../../../shared/types.js';

export const TIME_WINDOWS: readonly TimeWindow[] = ['m5', 'm15', 'm30', 'h1', 'h6', 'h24'];

type Windows<T> = Partial<Record<TimeWindow, T>>;

export function emptySnapshot(chain: ChainId, address: string, ts: number): TokenSnapshot {
  return {
    chain,
    address,
    symbol: '',
    name: '',
    pairAddress: null,
    dex: null,
    ts,
    priceUsd: null,
    marketCapUsd: null,
    fdvUsd: null,
    liquidityUsd: null,
    volumeUsd: {},
    priceChangePct: {},
    txns: {},
    holders: null,
    top10HolderPct: null,
    createdAt: null,
    imageUrl: null,
    links: [],
    security: null,
    sources: [],
    boosted: false,
  };
}

/**
 * Overlay `extra` on `base`. Identity (chain, address) comes from `base`.
 * For every field a non-null value in `extra` wins, otherwise `base` is kept;
 * per-window maps and security flags merge field by field. Sources and links
 * are unioned (links deduped by URL), `boosted` is OR-ed, `createdAt` keeps the
 * earliest known value and `ts` the latest. Pure and deterministic.
 */
export function mergeSnapshots(base: TokenSnapshot, extra: Partial<TokenSnapshot>): TokenSnapshot {
  return {
    chain: base.chain,
    address: preferChecksummed(base.address, extra.address),
    symbol: pickText(extra.symbol, base.symbol),
    name: pickText(extra.name, base.name),
    pairAddress: extra.pairAddress ?? base.pairAddress,
    dex: extra.dex ?? base.dex,
    ts: Math.max(base.ts, extra.ts ?? base.ts),
    priceUsd: extra.priceUsd ?? base.priceUsd,
    marketCapUsd: extra.marketCapUsd ?? base.marketCapUsd,
    fdvUsd: extra.fdvUsd ?? base.fdvUsd,
    liquidityUsd: extra.liquidityUsd ?? base.liquidityUsd,
    volumeUsd: mergeWindows(base.volumeUsd, extra.volumeUsd),
    priceChangePct: mergeWindows(base.priceChangePct, extra.priceChangePct),
    txns: mergeTxns(base.txns, extra.txns),
    holders: extra.holders ?? base.holders,
    top10HolderPct: extra.top10HolderPct ?? base.top10HolderPct,
    createdAt: earliest(base.createdAt, extra.createdAt ?? null),
    imageUrl: extra.imageUrl ?? base.imageUrl,
    links: mergeLinks(base.links, extra.links ?? []),
    security: mergeSecurity(base.security, extra.security ?? null),
    sources: unique([...base.sources, ...(extra.sources ?? [])]),
    boosted: base.boosted || extra.boosted === true,
  };
}

/**
 * Same EVM address, different casing: GeckoTerminal reports EVM addresses in
 * lowercase, DexScreener in EIP-55 checksum casing. Keep the checksummed form.
 */
function preferChecksummed(address: string, other: string | undefined): string {
  if (!other || !/^0x/i.test(address) || other === address) return address;
  if (other.toLowerCase() !== address.toLowerCase()) return address;
  return address === address.toLowerCase() ? other : address;
}

function pickText(preferred: string | undefined, fallback: string): string {
  return preferred !== undefined && preferred.trim() !== '' ? preferred : fallback;
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function mergeWindows(base: Windows<number | null>, extra: Windows<number | null> | undefined): Windows<number | null> {
  const out: Windows<number | null> = {};
  for (const w of TIME_WINDOWS) {
    if (!(w in base) && !(extra && w in extra)) continue;
    out[w] = extra?.[w] ?? base[w] ?? null;
  }
  return out;
}

function mergeTxns(base: Windows<TxCounts>, extra: Windows<TxCounts> | undefined): Windows<TxCounts> {
  const out: Windows<TxCounts> = {};
  for (const w of TIME_WINDOWS) {
    const a = base[w];
    const b = extra?.[w];
    if (!a && !b) continue;
    out[w] = {
      buys: b?.buys ?? a?.buys ?? null,
      sells: b?.sells ?? a?.sells ?? null,
      buyers: b?.buyers ?? a?.buyers ?? null,
      sellers: b?.sellers ?? a?.sellers ?? null,
    };
  }
  return out;
}

function mergeSecurity(base: TokenSecurity | null, extra: TokenSecurity | null): TokenSecurity | null {
  if (!extra) return base;
  if (!base) return extra;
  return {
    mintAuthority: extra.mintAuthority ?? base.mintAuthority,
    freezeAuthority: extra.freezeAuthority ?? base.freezeAuthority,
    honeypot: extra.honeypot !== 'unknown' ? extra.honeypot : base.honeypot,
    devHoldingPct: extra.devHoldingPct ?? base.devHoldingPct,
  };
}

export function mergeLinks(base: TokenLink[], extra: TokenLink[]): TokenLink[] {
  const seen = new Set<string>();
  const out: TokenLink[] = [];
  for (const link of [...base, ...extra]) {
    const key = linkKey(link.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

/** Providers disagree on scheme, "www." and twitter.com vs x.com for the same profile. */
function linkKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/^twitter\.com\//, 'x.com/')
    .replace(/\/+$/, '');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/* ─────────────────────── field parsers shared by providers ─────────────────────── */

/** Finite number from a number or numeric string; anything else (NaN, '', null, junk) is null. */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Epoch ms from an ISO string or an epoch number (seconds are upgraded to ms). */
export function toEpochMs(v: unknown): number | null {
  if (typeof v === 'string' && v.trim() !== '' && !/^\d+(\.\d+)?$/.test(v.trim())) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  const n = toNum(v);
  if (n === null || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

export function toStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function toHttpUrl(v: unknown): string | null {
  const s = toStr(v);
  return s !== null && /^https?:\/\/\S+$/i.test(s) ? s : null;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Copy the windows present in `src`, converting each value. */
export function mapWindows<T>(src: unknown, convert: (v: unknown) => T): Windows<T> {
  const rec = asRecord(src);
  const out: Windows<T> = {};
  for (const w of TIME_WINDOWS) {
    if (w in rec) out[w] = convert(rec[w]);
  }
  return out;
}

/** Canonical comparison key for an address: EVM hex is case-insensitive, base58 is not. */
export function addressKey(address: string): string {
  const a = address.trim();
  return /^0x[0-9a-fA-F]+$/.test(a) ? a.toLowerCase() : a;
}

/** Map a provider's social/link kind ("twitter", "x", "Website", "tiktok", ...) to a TokenLink. */
export function makeLink(kind: string | null, url: unknown, label?: string | null): TokenLink | null {
  const href = toHttpUrl(url);
  if (!href) return null;
  const k = (kind ?? '').trim().toLowerCase();
  const type = LINK_TYPES[k] ?? (k === '' && isTwitterUrl(href) ? 'twitter' : 'other');
  const text = toStr(label) ?? (type === 'other' && k !== '' ? k : null);
  return text !== null ? { type, url: href, label: text } : { type, url: href };
}

const LINK_TYPES: Record<string, TokenLink['type']> = {
  website: 'website',
  web: 'website',
  twitter: 'twitter',
  x: 'twitter',
  telegram: 'telegram',
  discord: 'discord',
};

function isTwitterUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i.test(url);
}

export function compactLinks(links: Array<TokenLink | null>): TokenLink[] {
  return mergeLinks(
    [],
    links.filter((l): l is TokenLink => l !== null),
  );
}
