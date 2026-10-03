/*
 * 4chan /biz/ catalog (a.4cdn.org/biz/catalog.json): live threads whose
 * subject or opening post mention the token. One cached request covers every search.
 */
import type { IntelItem } from '../../../../shared/types.js';
import { fetchJson } from '../../net/http.js';
import { asArray, asRecord, toEpochMs, toNum } from '../../sources/merge.js';
import { classifyFreshness } from '../freshness.js';
import {
  cashtagRegExp,
  clip,
  containsAddress,
  excerpt,
  htmlToText,
  intelTerms,
  MIN_SYMBOL_CHARS,
  phraseRegExp,
  type IntelQuery,
  type IntelTerms,
  type MatchedOn,
} from './match.js';

const BIZ_CATALOG = 'https://a.4cdn.org/biz/catalog.json';
const THREAD_URL = 'https://boards.4chan.org/biz/thread/';
const CACHE_TTL_MS = 60_000;
const MAX_ITEMS = 15;
const TITLE_MAX = 90;
const SNIPPET_MAX = 220;
/** shorter names are everyday words on /biz/ */
const MIN_NAME_CHARS = 4;

export async function search(t: IntelQuery, opts: { signal?: AbortSignal } = {}): Promise<IntelItem[]> {
  const json = await fetchJson(BIZ_CATALOG, { limiter: 'biz', cacheTtlMs: CACHE_TTL_MS, signal: opts.signal });
  return parseBizCatalog(json, t, Date.now());
}

/**
 * Catalog pages → threads mentioning the contract address, the "$SYMBOL"
 * cashtag or the exact token name; the most recently active first, at most 15.
 */
export function parseBizCatalog(json: unknown, t: IntelQuery, now: number): IntelItem[] {
  const terms = intelTerms(t);
  const matches = threadMatcher(terms);
  const found: Array<{ item: IntelItem; activity: number }> = [];
  for (const page of asArray(json)) {
    for (const raw of asArray(asRecord(page).threads)) {
      const thread = asRecord(raw);
      const no = toNum(thread.no);
      if (no === null) continue;
      const subject = htmlToText(typeof thread.sub === 'string' ? thread.sub : null);
      const body = htmlToText(typeof thread.com === 'string' ? thread.com : null);
      const matchedOn = matches(`${subject}\n${body}`);
      if (!matchedOn) continue;
      const createdAt = toEpochMs(thread.time);
      const bumpedAt = toEpochMs(thread.last_modified);
      const publishedAt = createdAt ?? bumpedAt;
      found.push({
        activity: bumpedAt ?? createdAt ?? 0,
        item: {
          id: `biz:${no}`,
          title: subject || clip(body, TITLE_MAX) || `/biz/ thread ${no}`,
          url: `${THREAD_URL}${no}`,
          sourceName: '/biz/',
          sourceType: 'forum',
          provider: 'biz',
          publishedAt,
          freshness: classifyFreshness(publishedAt, now),
          snippet: body ? excerpt(body, SNIPPET_MAX, terms) : null,
          matchedOn,
        },
      });
    }
  }
  return found
    .sort((a, b) => b.activity - a.activity)
    .slice(0, MAX_ITEMS)
    .map((f) => f.item);
}

/**
 * Address, "$SYMBOL" or the exact name — never the bare symbol, which is too noisy
 * on a forum. A short or common ticker's cashtag counts only with corroboration (the
 * shared matcher decides), and only a distinctive name counts on its own.
 */
function threadMatcher(terms: IntelTerms): (text: string) => MatchedOn | null {
  const cashtag = terms.symbol.length >= MIN_SYMBOL_CHARS ? cashtagRegExp(terms.symbol) : null;
  const name = terms.nameDistinctive && terms.name.length >= MIN_NAME_CHARS ? phraseRegExp(terms.name) : null;
  return (text) => {
    if (containsAddress(text, terms.address)) return 'contract';
    if (cashtag?.test(text) && terms.match(text) !== null) return 'symbol';
    if (name?.test(text)) return 'name';
    return null;
  };
}
