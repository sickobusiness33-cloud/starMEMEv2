/*
 * GDELT DOC 2.0 article search (api.gdeltproject.org/api/v2/doc/doc): news
 * coverage of a token over the last 3 days. GDELT answers query-syntax errors
 * and throttling with plain text instead of JSON, so bodies are decoded defensively.
 */
import type { IntelItem, IntelSourceType } from '../../../../shared/types.js';
import { errMsg } from '../../log.js';
import { fetchText, HttpError } from '../../net/http.js';
import { asArray, asRecord, toHttpUrl, toStr } from '../../sources/merge.js';
import { classifyFreshness, parsePublishedDate } from '../freshness.js';
import { cleanTerm, intelTerms, stableId, type IntelQuery, type IntelTerms, type MatchedOn } from './match.js';

const GDELT_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const CACHE_TTL_MS = 120_000;
/** GDELT often takes 5–15 s, even to say "slow down"; stays inside the 20 s provider budget */
const REQUEST_TIMEOUT_MS = 18_000;
const MAX_RECORDS = 30;
/** GDELT rejects keywords shorter than this */
const MIN_KEYWORD_CHARS = 3;

/** Article must also talk about crypto: cuts "Bonk" the sound effect, "Cat" the pet. */
const CONTEXT_KEYWORDS = ['crypto', 'cryptocurrency', 'token', 'memecoin', 'blockchain', 'defi'];

/**
 * GDELT answers an over-eager client slowly (10-15 s) with a 429 or 503. After
 * such an answer it is left alone for a while, doubling from 1 to 10 minutes,
 * so a Radar search does not spend its time budget on a request that will fail.
 */
const COOLDOWN_BASE_MS = 60_000;
const COOLDOWN_MAX_MS = 10 * 60_000;
const cooldown = { failures: 0, until: 0, lastError: '' };

/** Test hook. */
export function resetGdeltCooldown(): void {
  Object.assign(cooldown, { failures: 0, until: 0, lastError: '' });
}

function isThrottled(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 0 || e.status === 429 || e.status >= 500);
}

export async function search(t: IntelQuery): Promise<IntelItem[]> {
  const terms = intelTerms(t);
  const query = buildGdeltQuery(terms);
  if (query === null) return [];
  const now = Date.now();
  if (now < cooldown.until) {
    const seconds = Math.ceil((cooldown.until - now) / 1000);
    throw new Error(`GDELT unavailable after "${cooldown.lastError}", next attempt in ${seconds}s`);
  }
  const params = [
    `query=${encodeURIComponent(query)}`,
    'mode=artlist',
    'format=json',
    'timespan=3d',
    `maxrecords=${MAX_RECORDS}`,
    'sort=datedesc',
  ];
  let body: string;
  try {
    body = await fetchText(`${GDELT_API}?${params.join('&')}`, {
      limiter: 'gdelt',
      cacheTtlMs: CACHE_TTL_MS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      // GDELT throttles per IP for several seconds: a quick retry only fails again and hides the 429
      retries: 0,
      // and while it is refusing us, report that at once instead of waiting out the pause into a timeout
      maxPauseWaitMs: 0,
    });
  } catch (e) {
    if (isThrottled(e)) {
      cooldown.failures += 1;
      cooldown.until = Date.now() + Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (cooldown.failures - 1));
      cooldown.lastError = errMsg(e);
    }
    throw e;
  }
  cooldown.failures = 0;
  return parseGdeltArticles(decodeGdeltBody(body), Date.now(), queryMatchedOn(terms));
}

/* ───────────────────────────── query ───────────────────────────── */

/**
 * `(<token terms> OR <address>) (<crypto context>)`, or the bare address when the
 * token has no searchable name. Ambiguous words are searched as "X coin" / "X token".
 * Single words stay unquoted (GDELT rejects some one-word phrases as "too short");
 * multi-word phrases are quoted; parentheses only wrap two or more OR'd terms.
 */
export function buildGdeltQuery(terms: IntelTerms): string | null {
  const address = keyword(terms.address);
  const tokenTerms = tokenKeywords(terms);
  if (tokenTerms.length === 0) return address;
  return `${orGroup([...tokenTerms, ...(address ? [address] : [])])} ${orGroup(CONTEXT_KEYWORDS)}`;
}

function tokenKeywords(t: IntelTerms): string[] {
  const name = gdeltText(t.name);
  const symbol = t.symbolUsable ? gdeltText(t.symbol) : '';
  const out = name.length >= MIN_KEYWORD_CHARS ? variants(name, t.nameDistinctive) : [];
  if (symbol.length >= MIN_KEYWORD_CHARS && symbol.toLowerCase() !== name.toLowerCase()) {
    out.push(...variants(symbol, !t.symbolAmbiguous));
  }
  return out;
}

/** A distinctive term is searched as is; an ambiguous one only in its ticker forms. */
function variants(term: string, distinctive: boolean): string[] {
  if (!distinctive) return [`"${term} coin"`, `"${term} token"`];
  const k = keyword(term);
  return k ? [k] : [];
}

/** One GDELT keyword: bare when it is a single word, quoted when it is a phrase. */
function keyword(text: string): string | null {
  const clean = gdeltText(text);
  if (clean.length < MIN_KEYWORD_CHARS) return null;
  return clean.includes(' ') ? `"${clean}"` : clean;
}

/** GDELT matches words; quotes, parentheses and other operators would break the query. */
function gdeltText(s: string): string {
  return cleanTerm(s.replace(/[^\p{L}\p{N}\s]+/gu, ' '));
}

function orGroup(terms: string[]): string {
  const list = terms.filter((t) => t.length > 0);
  return list.length === 1 ? (list[0] ?? '') : `(${list.join(' OR ')})`;
}

/** What a hit most likely matched on; the relevance filter refines it from the title. */
function queryMatchedOn(terms: IntelTerms): MatchedOn {
  if (tokenKeywords(terms).length === 0) return 'contract';
  return terms.nameDistinctive || !terms.symbolUsable ? 'name' : 'symbol';
}

/* ───────────────────────────── parsing ───────────────────────────── */

/**
 * GDELT JSON, which occasionally carries raw control characters or `\'`
 * escapes. Plain-text bodies are GDELT error / throttle messages.
 */
export function decodeGdeltBody(body: string): unknown {
  const text = body.trim();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fall through to the repaired parse
  }
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' ').replace(/\\'/g, "'")) as unknown;
    } catch {
      throw new Error('GDELT returned malformed JSON');
    }
  }
  throw new Error(`GDELT: ${text.split('\n')[0]?.slice(0, 160) ?? 'non-JSON response'}`);
}

export function parseGdeltArticles(json: unknown, now: number, matchedOn: MatchedOn = 'name'): IntelItem[] {
  const out: IntelItem[] = [];
  const seen = new Set<string>();
  for (const raw of asArray(asRecord(json).articles)) {
    const a = asRecord(raw);
    const url = toHttpUrl(a.url);
    const title = cleanTitle(toStr(a.title) ?? '');
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const domain = (toStr(a.domain) ?? hostOf(url)).toLowerCase();
    const publishedAt = parsePublishedDate(toStr(a.seendate), now);
    out.push({
      id: stableId('gdelt', url),
      title,
      url,
      sourceName: domain,
      sourceType: sourceTypeFor(domain),
      provider: 'gdelt',
      publishedAt,
      freshness: classifyFreshness(publishedAt, now),
      snippet: null,
      matchedOn,
    });
  }
  return out;
}

/** GDELT pads punctuation with spaces: "Bitcoin , Ethereum , XRP" → "Bitcoin, Ethereum, XRP". */
function cleanTitle(title: string): string {
  return title
    .replace(/\s+([,.:;?!%)])/g, '$1')
    .replace(/([(])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const BLOG_DOMAINS = ['medium.com', 'substack.com', 'mirror.xyz', 'paragraph.xyz', 'hashnode.dev', 'blogspot.com', 'wordpress.com', 'ghost.io'];
const CRYPTO_PRESS = [
  'coindesk.com', 'cointelegraph.com', 'decrypt.co', 'theblock.co', 'blockworks.co', 'dlnews.com', 'thedefiant.io',
  'bitcoinmagazine.com', 'cryptoslate.com', 'cryptonews.com', 'cryptopotato.com', 'coinspeaker.com', 'bitcoinist.com',
  'newsbtc.com', 'beincrypto.com', 'u.today', 'coingape.com', 'ambcrypto.com', 'crypto.news', 'cryptobriefing.com',
  'coinjournal.net', 'zycrypto.com', 'watcher.guru', 'protos.com', 'coinpedia.org', 'cryptopolitan.com', 'thecryptobasic.com',
];

function sourceTypeFor(domain: string): IntelSourceType {
  if (BLOG_DOMAINS.some((d) => onDomain(domain, d))) return 'blog';
  if (CRYPTO_PRESS.some((d) => onDomain(domain, d))) return 'specialized';
  return 'news';
}

function onDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
