/*
 * Hacker News mentions through the Algolia HN Search API (search_by_date):
 * stories and comments, newest first.
 */
import type { IntelItem } from '../../../../shared/types.js';
import { errMsg, logger } from '../../log.js';
import { fetchJson } from '../../net/http.js';
import { asArray, asRecord, toEpochMs, toHttpUrl, toStr } from '../../sources/merge.js';
import { classifyFreshness, parsePublishedDate } from '../freshness.js';
import { clip, excerpt, htmlToText, intelTerms, type IntelQuery, type IntelTerms, type MatchedOn } from './match.js';

const log = logger('intel:hn');

const HN_SEARCH = 'https://hn.algolia.com/api/v1/search_by_date';
const HN_ITEM = 'https://news.ycombinator.com/item?id=';
const CACHE_TTL_MS = 120_000;
const HITS_PER_PAGE = 30;
const SNIPPET_MAX = 220;
const TITLE_MAX = 160;

export interface HnSearchOpts {
  /** also search the contract address (default true); the detection pipeline skips it to save requests */
  includeAddress?: boolean;
}

/** Throws only when every query failed. */
export async function search(t: IntelQuery, opts: HnSearchOpts = {}): Promise<IntelItem[]> {
  const terms = intelTerms(t);
  const queries = hnQueries(terms, opts.includeAddress ?? true);
  const results = await Promise.allSettled(
    queries.map((q) => fetchJson(hnSearchUrl(q.text), { limiter: 'hn', cacheTtlMs: CACHE_TTL_MS })),
  );
  const now = Date.now();
  const items = new Map<string, IntelItem>();
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      errors.push(errMsg(r.reason));
      return;
    }
    for (const item of parseHnHits(r.value, now, queries[i]?.matchedOn, terms)) {
      if (!items.has(item.id)) items.set(item.id, item);
    }
  });
  if (queries.length > 0 && errors.length === queries.length) throw new Error(`HN search failed: ${errors[0]}`);
  if (errors.length > 0) log.warn('HN query failed', { symbol: t.symbol, error: errors[0] });
  return [...items.values()];
}

interface HnQuery {
  text: string;
  matchedOn: MatchedOn;
}

/** The most specific text term (quoted: exact phrase, no typo tolerance) and the contract address. */
function hnQueries(terms: IntelTerms, includeAddress: boolean): HnQuery[] {
  const queries: HnQuery[] = [];
  if (terms.nameDistinctive) queries.push({ text: terms.name, matchedOn: 'name' });
  else if (terms.symbolUsable) queries.push({ text: terms.symbol, matchedOn: 'symbol' });
  if (includeAddress && terms.address) queries.push({ text: terms.address, matchedOn: 'contract' });
  return queries;
}

function hnSearchUrl(text: string): string {
  const phrase = `"${text.replace(/"/g, ' ').trim()}"`;
  return `${HN_SEARCH}?query=${encodeURIComponent(phrase)}&tags=${encodeURIComponent('(story,comment)')}&hitsPerPage=${HITS_PER_PAGE}`;
}

/* ───────────────────────────── parsing ───────────────────────────── */

/** Algolia `hits[]` → items. Comments link to the comment itself; stories to their article. */
export function parseHnHits(
  json: unknown,
  now: number,
  matchedOn: MatchedOn = 'name',
  terms?: Pick<IntelTerms, 'address' | 'name' | 'symbol'>,
): IntelItem[] {
  const out: IntelItem[] = [];
  for (const raw of asArray(asRecord(json).hits)) {
    const hit = asRecord(raw);
    const id = toStr(hit.objectID) ?? (typeof hit.objectID === 'number' ? String(hit.objectID) : null);
    if (!id) continue;
    const publishedAt = toEpochMs(hit.created_at_i) ?? parsePublishedDate(toStr(hit.created_at), now);
    const base = { id: `hn:${id}`, sourceName: 'Hacker News', provider: 'hn', publishedAt, matchedOn };
    const freshness = classifyFreshness(publishedAt, now);
    const item = isComment(hit) ? commentItem(hit, id, terms) : storyItem(hit, id, terms);
    if (item) out.push({ ...base, ...item, freshness });
  }
  return out;
}

type HitContent = Pick<IntelItem, 'title' | 'url' | 'sourceType' | 'snippet'>;

function isComment(hit: Record<string, unknown>): boolean {
  const tags = asArray(hit._tags);
  return tags.includes('comment') || (!tags.includes('story') && toStr(hit.comment_text) !== null);
}

function storyItem(hit: Record<string, unknown>, id: string, terms?: Pick<IntelTerms, 'address' | 'name' | 'symbol'>): HitContent | null {
  const title = htmlToText(toStr(hit.title));
  if (!title) return null;
  const external = toHttpUrl(hit.url);
  const text = htmlToText(toStr(hit.story_text));
  return {
    title: clip(title, TITLE_MAX),
    url: external ?? HN_ITEM + id,
    sourceType: external ? 'article' : 'community',
    snippet: text ? excerpt(text, SNIPPET_MAX, terms) : null,
  };
}

function commentItem(hit: Record<string, unknown>, id: string, terms?: Pick<IntelTerms, 'address' | 'name' | 'symbol'>): HitContent | null {
  const text = htmlToText(toStr(hit.comment_text));
  if (!text) return null;
  const storyTitle = htmlToText(toStr(hit.story_title));
  // moderated stories keep a placeholder title ("[dead]", "[flagged]") that says nothing to a reader
  const story = /^\[(dead|flagged|deleted)\]$/i.test(storyTitle.trim()) ? '' : storyTitle;
  return {
    title: clip(story ? `Re: ${story}` : 'Hacker News comment', TITLE_MAX),
    url: HN_ITEM + id,
    sourceType: 'community',
    snippet: excerpt(text, SNIPPET_MAX, terms),
  };
}
