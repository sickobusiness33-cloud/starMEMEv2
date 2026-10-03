/**
 * Number formatting shared by the writers and the distribution formats.
 * Unknown values (null, NaN, ±Infinity) always render as "—", never as 0.
 *
 * Dollar amounts use the compact "$1.4M" style in every language; plain
 * decimals (percentages, multiples, counts) follow the language convention
 * ("4.2x" in English, "4,2x" in Spanish).
 */

export type Lang = 'es' | 'en';

export const DASH = '—';

/** Below this, a positive amount is shown in exponential form rather than as a long run of zeros. */
const MIN_PLAIN_USD = 1e-15;
const SIGNIFICANT_DIGITS = 3;

const UNITS: ReadonlyArray<{ value: number; suffix: string }> = [
  { value: 1e3, suffix: 'K' },
  { value: 1e6, suffix: 'M' },
  { value: 1e9, suffix: 'B' },
  { value: 1e12, suffix: 'T' },
];

export function isNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** $1.4M · $620K · $8.2K · $512 · $1.23 · $0.0000123 · "—" */
export function fmtUsd(n: number | null): string {
  if (!isNum(n)) return DASH;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${usdBody(Math.abs(n))}`;
}

/** +31% · -4.2% (es: -4,2%) · 0% · "—". Default precision: 1 decimal under 10, none above. */
export function fmtPct(n: number | null, digits?: number, lang: Lang = 'en'): string {
  if (!isNum(n)) return DASH;
  const d = digits ?? (Math.abs(n) >= 10 ? 0 : 1);
  const factor = 10 ** d;
  const rounded = Math.round(Math.abs(n) * factor) / factor;
  if (rounded === 0) return '0%';
  return `${n > 0 ? '+' : '-'}${decimal(rounded, d, lang)}%`;
}

/** Unsigned share, e.g. 68% (es: 68%, 4,5%). */
export function fmtShare(n: number | null, lang: Lang = 'en'): string {
  if (!isNum(n)) return DASH;
  const d = Math.abs(n) >= 10 ? 0 : 1;
  return `${decimal(n, d, lang)}%`;
}

/** 4.2x (es: 4,2x) · 12x */
export function fmtMult(n: number | null, lang: Lang = 'en'): string {
  if (!isNum(n)) return DASH;
  return `${decimal(n, Math.abs(n) >= 10 ? 0 : 1, lang)}x`;
}

/** A rate such as transactions per minute: 184 · 4.6 (es: 4,6) */
export function fmtRate(n: number | null, lang: Lang = 'en'): string {
  if (!isNum(n)) return DASH;
  return decimal(n, Math.abs(n) >= 10 ? 0 : 1, lang);
}

/** 1,284 (es: 1284 / 12.840, RAE grouping) */
export function fmtNum(n: number | null, lang: Lang = 'en'): string {
  if (!isNum(n)) return DASH;
  return decimal(Math.round(n), 0, lang);
}

/** "hace 24 min" / "24 min ago"; hours from 60 min, days from 24 h. */
export function fmtAge(minutes: number | null, lang: Lang): string {
  if (!isNum(minutes) || minutes < 0) return DASH;
  if (minutes < 1) return lang === 'es' ? 'hace menos de 1 min' : 'less than 1 min ago';
  const span = fmtSpan(minutes, Math.floor);
  return lang === 'es' ? `hace ${span}` : `${span} ago`;
}

/**
 * A length of time: "21 min", "3 h", "2 d". Counts whole elapsed units, like
 * fmtAge, so one article never calls the same age "hace 13 min" and "14 min".
 */
export function fmtDuration(minutes: number | null): string {
  if (!isNum(minutes) || minutes < 0) return DASH;
  return fmtSpan(Math.max(1, minutes), Math.floor);
}

function fmtSpan(minutes: number, round: (x: number) => number): string {
  if (minutes < 60) return `${Math.max(1, round(minutes))} min`;
  if (minutes < 24 * 60) return `${Math.max(1, round(minutes / 60))} h`;
  return `${Math.max(1, round(minutes / (24 * 60)))} d`;
}

/* ───────────── internals ───────────── */

function usdBody(x: number): string {
  if (x >= 999.5) return compact(x);
  if (x >= 100) return String(Math.round(x));
  if (x >= 1) return x.toFixed(2);
  if (x === 0) return '0';
  if (x < MIN_PLAIN_USD) return x.toExponential(2);
  return significant(x, SIGNIFICANT_DIGITS);
}

/** Scales into K/M/B/T, promoting to the next unit when rounding reaches 1000 ($999.96K → $1M). */
function compact(x: number): string {
  for (let i = 0; i < UNITS.length; i++) {
    const unit = UNITS[i]!;
    const next = UNITS[i + 1];
    if (next && x >= next.value) continue;
    const v = x / unit.value;
    const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
    if (rounded >= 1000 && next) continue;
    return `${trimZeros(rounded.toFixed(rounded < 10 ? 1 : 0))}${unit.suffix}`;
  }
  return String(Math.round(x));
}

/** 0.0000123456 → "0.0000123" (plain notation, trailing zeros removed). */
function significant(x: number, digits: number): string {
  const exponent = Math.floor(Math.log10(x));
  const decimals = Math.min(20, Math.max(0, digits - 1 - exponent));
  return trimZeros(x.toFixed(decimals));
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

const formatters = new Map<string, Intl.NumberFormat>();

function decimal(n: number, maxDigits: number, lang: Lang): string {
  const key = `${lang}:${maxDigits}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxDigits,
    });
    formatters.set(key, f);
  }
  return f.format(n);
}
