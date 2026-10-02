/**
 * Display formatting. Every helper renders `null` / non-finite as "—":
 * an unknown value is never shown as 0.
 */

export const DASH = '—';
const MINUS = '−';

const isNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
const toSubscript = (n: number) => String(n).replace(/\d/g, (d) => SUBSCRIPT[Number(d)] ?? d);

function trimZero(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** $1.4B · $1.4M · $620K · $12.40 · $0.0000123 · $0.0₇123 */
export function fmtUsd(n: number | null | undefined): string {
  if (!isNum(n)) return DASH;
  const sign = n < 0 ? MINUS : '';
  const a = Math.abs(n);
  if (a === 0) return '$0';
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (a >= size) {
      const v = a / size;
      return `${sign}$${trimZero(v.toFixed(v < 100 ? 1 : 0))}${suffix}`;
    }
  }
  if (a >= 1) return `${sign}$${a.toFixed(2)}`;
  // sub-dollar: three significant digits, long zero runs compressed (DexScreener-style)
  const exp = Math.floor(Math.log10(a));
  const zeros = -exp - 1;
  const digits = Math.min(20, zeros + 3);
  const fixed = trimZero(a.toFixed(digits));
  // count zeros on the rounded string: 9.99e-8 rounds to 0.0000001
  const frac = fixed.split('.')[1] ?? '';
  const z = frac.length - frac.replace(/^0+/, '').length;
  if (z >= 6) return `${sign}$0.0${toSubscript(z)}${frac.slice(z)}`;
  return `${sign}$${fixed}`;
}

/** +12.4% · −3.1% (sign shown by default) */
export function fmtPct(n: number | null | undefined, digits = 1, opts: { sign?: boolean } = {}): string {
  if (!isNum(n)) return DASH;
  const showSign = opts.sign ?? true;
  const a = Math.abs(n);
  const d = a >= 1000 ? 0 : digits;
  const body = a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = n < 0 ? MINUS : showSign && n > 0 ? '+' : '';
  return `${sign}${body}%`;
}

/** 1,204 · 12.4K (compact) */
export function fmtNum(n: number | null | undefined, opts: { compact?: boolean; digits?: number } = {}): string {
  if (!isNum(n)) return DASH;
  if (opts.compact && Math.abs(n) >= 10_000) {
    return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  }
  const d = opts.digits ?? (Number.isInteger(n) ? 0 : Math.abs(n) < 10 ? 1 : 0);
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', MINUS);
}

/**
 * Buy/sell split as whole percentages that always add up to 100 (36.4 / 63.6 → "36/64",
 * never "36/65" from rounding each side on its own). Null when either side is unknown.
 */
export function fmtSplit(buy: number | null | undefined, sell: number | null | undefined): string | null {
  if (!isNum(buy) || !isNum(sell) || buy + sell <= 0) return null;
  const b = Math.round((buy / (buy + sell)) * 100);
  return `${b}/${100 - b}`;
}

/** 4.1x */
export function fmtMult(n: number | null | undefined): string {
  if (!isNum(n)) return DASH;
  return `${n >= 10 ? Math.round(n) : n.toFixed(1)}x`;
}

/** 840 ms · 2.4 s · 3 min */
export function fmtMs(ms: number | null | undefined): string {
  if (!isNum(ms)) return DASH;
  const a = Math.max(0, ms);
  if (a < 1000) return `${Math.round(a)} ms`;
  if (a < 60_000) return `${(a / 1000).toFixed(a < 10_000 ? 1 : 0)} s`;
  return `${Math.round(a / 60_000)} min`;
}

/** Token age from minutes: 12 min · 3 h · 2 d */
export function fmtAge(minutes: number | null | undefined): string {
  if (!isNum(minutes)) return DASH;
  const m = Math.max(0, minutes);
  if (m < 1) return '<1 min';
  if (m < 60) return `${Math.floor(m)} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / 1440)} d`;
}

/** '18 min ago' — resolution matches the shared 15 s ticker, so nothing under a minute is claimed. */
export function timeAgo(ts: number | null | undefined, now: number): string {
  if (!isNum(ts)) return DASH;
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Seconds-resolution age for the 1 s clock (chain chips): 12s · 4m · 2h */
export function shortSince(ts: number | null | undefined, now: number): string {
  if (!isNum(ts)) return DASH;
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 100) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 100) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 14:32:05 (UTC) */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** 2026-10-01 14:32 UTC */
export function fmtDateTime(ts: number | null | undefined): string {
  if (!isNum(ts)) return DASH;
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** 7xKX…9fGh · 0x1234…abcd */
export function shortAddr(addr: string | null | undefined): string {
  if (!addr) return DASH;
  const head = addr.startsWith('0x') ? 6 : 4;
  if (addr.length <= head + 6) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-4)}`;
}

/** Window code → label: h1 → 1H */
export function fmtWindow(w: string | null | undefined): string {
  if (!w) return '';
  const unit = w[0] === 'm' ? 'M' : w[0] === 'h' ? 'H' : '';
  return `${w.slice(1)}${unit}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Only http(s) URLs are rendered as links. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** $TICKER — some tokens already carry the "$" in their symbol ("$HALLOWEEN"); never render "$$". Empty → "—". */
export function fmtTicker(symbol: string | null | undefined): string {
  const s = (symbol ?? '').trim().replace(/^\$+/, '');
  return s ? `$${s}` : DASH;
}
