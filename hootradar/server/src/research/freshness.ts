/*
 * Publish-date parsing and freshness classification for Radar intel.
 * Unparseable or implausible dates are null: freshness is never guessed.
 */
import { FRESHNESS_LIVE_MS, FRESHNESS_RECENT_MS, type Freshness } from '../../../shared/types.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Publishers' clocks drift; a timestamp up to this far in the future still counts as "now". */
export const FUTURE_TOLERANCE_MS = 10 * MINUTE_MS;

/** Nothing we index was published before this; earlier values are parse artefacts (e.g. epoch 0). */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);

export function classifyFreshness(publishedAt: number | null, now: number): Freshness {
  if (publishedAt === null || !Number.isFinite(publishedAt)) return 'UNKNOWN';
  const age = now - publishedAt;
  if (age < -FUTURE_TOLERANCE_MS) return 'UNKNOWN';
  if (age <= FRESHNESS_LIVE_MS) return 'LIVE';
  if (age <= FRESHNESS_RECENT_MS) return 'RECENT';
  return 'OLD';
}

/**
 * Epoch ms from the date formats our providers emit:
 * ISO 8601, RFC 2822, GDELT "20261001T143000Z", compact "YYYYMMDD[HHMMSS]",
 * unix seconds / milliseconds, "3 hours ago", "Oct 1, 2026", "1 October 2026".
 * Wall-clock values without a zone are read as UTC. Returns null when unsure.
 */
export function parsePublishedDate(raw: string | null | undefined, now: number): number | null {
  if (raw == null) return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  if (s === '') return null;
  const ms =
    parseCompact(s) ??
    parseEpoch(s) ??
    parseRelative(s, now) ??
    parseIso(s) ??
    parseRfc2822(s) ??
    parseMonthNameDate(s);
  return ms !== null && Number.isFinite(ms) && ms >= EARLIEST_PLAUSIBLE_MS ? ms : null;
}

/** GDELT seendate "20261001T143000Z", or digits-only "20261001" / "20261001143000". */
function parseCompact(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T?(\d{2})(\d{2})(\d{2})Z?)?$/.exec(s);
  if (!m) return null;
  // a bare 8/14-digit run could also be an epoch value; only accept it when it reads as a real date
  const [, y, mo, d, h = '0', mi = '0', se = '0'] = m;
  return utc(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(se));
}

/** Unix seconds (9–10 digits, optional fraction) or milliseconds (12–13 digits). */
function parseEpoch(s: string): number | null {
  if (/^\d{9,10}(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  if (/^\d{12,13}$/.test(s)) return Number(s);
  return null;
}

const RELATIVE_UNITS: Array<[RegExp, number]> = [
  [/^(s|secs?|seconds?)$/, 1000],
  [/^(m|mins?|minutes?)$/, MINUTE_MS],
  [/^(h|hrs?|hours?)$/, HOUR_MS],
  [/^(d|days?)$/, DAY_MS],
  [/^(w|wks?|weeks?)$/, 7 * DAY_MS],
  [/^(mos?|months?)$/, 30 * DAY_MS],
  [/^(y|yrs?|years?)$/, 365 * DAY_MS],
];

/** "3 hours ago", "an hour ago", "5m ago", "just now". */
function parseRelative(s: string, now: number): number | null {
  const lower = s.toLowerCase();
  if (lower === 'just now' || lower === 'now') return now;
  const m = /^(\d+|an?|one)\s*([a-z]+)\.? ago$/.exec(lower);
  if (!m) return null;
  const [, amount = '', unitText = ''] = m;
  const n = /^\d+$/.test(amount) ? Number(amount) : 1;
  const unit = RELATIVE_UNITS.find(([re]) => re.test(unitText));
  return unit ? now - n * unit[1] : null;
}

/** ISO 8601 date or date-time. A date-time without an offset is taken as UTC (JS would use local time). */
function parseIso(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se = '0', frac = '', zone] = m;
  if (h === undefined || mi === undefined) return utc(Number(y), Number(mo), Number(d));
  const base = utc(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(se));
  if (base === null) return null;
  const fracMs = frac ? Math.round(Number(frac) * 1000) : 0;
  return base + fracMs - zoneOffsetMs(zone);
}

/** "Wed, 01 Oct 2026 14:30:00 GMT" / "+0000". Requires an explicit zone; JS resolves it. */
function parseRfc2822(s: string): number | null {
  const re = /^(?:[a-z]{3},? )?\d{1,2} [a-z]{3,9} \d{4} \d{2}:\d{2}(?::\d{2})? ?(?:gmt|utc|ut|z|[+-]\d{4}|[ecmp][sd]t)$/i;
  if (!re.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** "Oct 1, 2026", "October 1st 2026", "Sept. 1, 2026", "1 October 2026" — UTC midnight of that day. */
function parseMonthNameDate(s: string): number | null {
  const monthFirst = /^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/i.exec(s);
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.?,? (\d{4})$/i.exec(s);
  const parts = monthFirst
    ? { month: monthFirst[1], day: monthFirst[2], year: monthFirst[3] }
    : dayFirst
      ? { month: dayFirst[2], day: dayFirst[1], year: dayFirst[3] }
      : null;
  if (!parts?.month || !parts.day || !parts.year) return null;
  const month = monthIndex(parts.month);
  return month === null ? null : utc(Number(parts.year), month + 1, Number(parts.day));
}

/** "oct", "october" and the common "sept"; look-alikes such as "marching" are rejected. */
function monthIndex(name: string): number | null {
  const lower = name.toLowerCase();
  if (lower === 'sept') return 8;
  const i = MONTHS.findIndex((m) => lower.length >= 3 && m.startsWith(lower));
  return i < 0 ? null : i;
}

/** UTC epoch ms for a calendar date-time; null when any component is out of range (e.g. Feb 30). */
function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number | null {
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const t = new Date(ms);
  const valid =
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === s;
  return valid ? ms : null;
}

function zoneOffsetMs(zone: string | undefined): number {
  if (!zone || zone.toUpperCase() === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * HOUR_MS + Number(m[3]) * MINUTE_MS);
}
