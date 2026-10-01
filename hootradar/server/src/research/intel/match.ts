/*
 * Search terms, text clean-up and relevance matching shared by the intel providers.
 * Precision first: a short or generic symbol ("AI", "CAT") never counts as a
 * mention on its own — it needs a $cashtag, the contract address, a specific
 * name, or a ticker form such as "CAT token" / "(CAT)".
 */
import { createHash } from 'node:crypto';
import type { ChainId, IntelItem, TokenLink } from '../../../../shared/types.js';

export interface IntelQuery {
  symbol: string;
  name: string;
  address: string;
  chain: ChainId;
  links: TokenLink[];
}

export type MatchedOn = IntelItem['matchedOn'];

export interface IntelTerms {
  /** cleaned symbol, without a leading "$" */
  symbol: string;
  name: string;
  address: string;
  /** symbols shorter than 3 characters are never searched or matched */
  symbolUsable: boolean;
  /** usable but short (3 chars) or a common word: needs corroboration */
  symbolAmbiguous: boolean;
  /** the name alone identifies the token (≥ 4 chars, not a common word) */
  nameDistinctive: boolean;
  /** name or symbol identifies the token without corroboration */
  distinctive: boolean;
  /** strongest evidence that `text` mentions the token, or null */
  match(text: string, opts?: MatchOpts): MatchedOn | null;
}

export interface MatchOpts {
  /**
   * The source is not about crypto (e.g. Hacker News): a bare name or symbol
   * only counts next to crypto vocabulary — "bonk" is also an English verb.
   */
  needsContext?: boolean;
}

export const MIN_SYMBOL_CHARS = 3;
const MIN_DISTINCTIVE_NAME_CHARS = 4;
const MIN_DISTINCTIVE_SYMBOL_CHARS = 4;

/**
 * Words that are also popular tickers / token names. Matching them bare would
 * pull in unrelated posts (pets, AI news, politics, majors).
 */
const COMMON_WORDS = new Set([
  'agent', 'agi', 'ai', 'alpha', 'america', 'ape', 'apes', 'baby', 'base', 'based', 'bear', 'beta', 'bitcoin',
  'bnb', 'btc', 'bull', 'buy', 'cash', 'cat', 'cats', 'chad', 'china', 'coin', 'community', 'crypto', 'dao',
  'defi', 'degen', 'doge', 'dog', 'dogs', 'dump', 'earth', 'elon', 'eth', 'ethereum', 'frog', 'fun', 'gem', 'god',
  'gold', 'gpt', 'hodl', 'hold', 'inu', 'internet', 'king', 'launch', 'life', 'lol', 'love', 'maga', 'mars',
  'meme', 'memes', 'money', 'moon', 'musk', 'new', 'nft', 'official', 'pepe', 'pump', 'queen', 'real', 'rich',
  'rocket', 'sell', 'shib', 'sol', 'solana', 'sun', 'test', 'the', 'token', 'trump', 'usa', 'wagmi', 'web3',
  'wow', 'world',
]);

/** Crypto vocabulary that makes a bare word in general-audience text read as a token reference. */
const CRYPTO_CONTEXT =
  /(?<![\p{L}\p{N}_])(?:crypto(?:s|currency|currencies)?|bitcoin|btc|ethereum|solana|binance|coinbase|blockchains?|defi|dex|dexscreener|web3|nfts?|airdrops?|(?:meme|shit|alt)[\s-]?coins?|on-?chain|pump\.fun|raydium|uniswap|rug[\s-]?pull\w*|market[\s-]?cap)(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_$])\$[a-z][a-z0-9]{1,9}(?![\p{L}\p{N}_])/iu;

const WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WORD_AFTER = '(?![\\p{L}\\p{N}_])';
const TICKER_NOUNS = '(?:coin|token|memecoin|meme[\\s-]?coin)s?';

export function intelTerms(t: IntelQuery): IntelTerms {
  const symbol = cleanTerm(t.symbol).replace(/^\$+/, '');
  const name = cleanTerm(t.name);
  const address = t.address.trim();
  const symbolUsable = symbol.length >= MIN_SYMBOL_CHARS;
  const symbolAmbiguous =
    symbolUsable && (symbol.length < MIN_DISTINCTIVE_SYMBOL_CHARS || isCommonPhrase(symbol) || /^\d+$/.test(symbol));
  const sameAsSymbol = name.toLowerCase() === symbol.toLowerCase();
  const nameDistinctive =
    name.length >= MIN_DISTINCTIVE_NAME_CHARS && !isCommonPhrase(name) && !(sameAsSymbol && symbolAmbiguous);
  const terms = { symbol, name, address, symbolUsable, symbolAmbiguous, nameDistinctive };
  return {
    ...terms,
    distinctive: nameDistinctive || (symbolUsable && !symbolAmbiguous),
    match: buildMatcher(terms),
  };
}

type TermFlags = Omit<IntelTerms, 'distinctive' | 'match'>;

function buildMatcher(t: TermFlags): IntelTerms['match'] {
  const sym = t.symbolUsable ? escapeRegExp(t.symbol) : null;
  const name = t.name.length >= MIN_SYMBOL_CHARS ? phrasePattern(t.name) : null;

  const cashtag = t.symbolUsable ? cashtagRegExp(t.symbol) : null;
  const namePhrase = name && t.nameDistinctive ? wordRegExp(name) : null;
  const bareSymbol = sym && !t.symbolAmbiguous ? wordRegExp(sym) : null;
  // "PEPE coin", "Pepe token", "Pepe (PEPE)": ticker forms corroborate an ambiguous word
  const symbolTicker = sym ? new RegExp(`${tickerNoun(sym)}|\\(\\$?${sym}\\)`, 'iu') : null;
  const nameTicker = name ? new RegExp(tickerNoun(name), 'iu') : null;

  return (text, opts = {}) => {
    if (containsAddress(text, t.address)) return 'contract';
    if (cashtag?.test(text)) return 'symbol';
    const word = namePhrase?.test(text) ? 'name' : bareSymbol?.test(text) ? 'symbol' : null;
    if (word && (!opts.needsContext || CRYPTO_CONTEXT.test(text))) return word;
    // ticker forms carry their own context
    if (symbolTicker?.test(text)) return 'symbol';
    if (nameTicker?.test(text)) return 'name';
    return null;
  };
}

function tickerNoun(pattern: string): string {
  return `${WORD_BEFORE}${pattern}[\\s-]*${TICKER_NOUNS}${WORD_AFTER}`;
}

/** EVM hex addresses compare case-insensitively; base58 addresses are case-sensitive. */
export function containsAddress(text: string, address: string): boolean {
  if (address.length === 0) return false;
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? text.toLowerCase().includes(address.toLowerCase()) : text.includes(address);
}

/** "$BONK" (case-insensitive), not "x$BONK" or "$BONKERS". */
export function cashtagRegExp(symbol: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_$])\\$${escapeRegExp(symbol)}${WORD_AFTER}`, 'iu');
}

/** Whole-word, case-insensitive phrase; "Dog Wif Hat" also matches "dog-wif-hat" (URL slugs). */
export function phraseRegExp(phrase: string): RegExp {
  return wordRegExp(phrasePattern(phrase));
}

function phrasePattern(phrase: string): string {
  return phrase.split(/[\s_-]+/).filter(Boolean).map(escapeRegExp).join('[\\s_-]+');
}

function wordRegExp(pattern: string): RegExp {
  return new RegExp(`${WORD_BEFORE}${pattern}${WORD_AFTER}`, 'iu');
}

function isCommonPhrase(s: string): boolean {
  const words = s.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => COMMON_WORDS.has(w));
}

/** Collapses whitespace and drops control / zero-width characters. */
export function cleanTerm(s: string): string {
  return s
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ───────────────────────────── text helpers ───────────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Plain text from a forum/HN HTML fragment. `<wbr>` is dropped without a space
 * because 4chan inserts it inside long words such as contract addresses.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<wbr\s*\/?>/gi, '')
      .replace(/<\/?(?:br|p|div|li|ul|ol|tr|td|h[1-6]|blockquote|pre)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shortens to at most `max` characters, preferring a word boundary, with an ellipsis. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

const EXCERPT_LEAD_CHARS = 60;

/**
 * At most `max` characters of `text`; when the first mention of the token lies
 * beyond the opening, the window starts shortly before it so the snippet shows it.
 */
export function excerpt(text: string, max: number, terms?: Pick<IntelTerms, 'address' | 'name' | 'symbol'>): string {
  if (text.length <= max || !terms) return clip(text, max);
  const lower = text.toLowerCase();
  const hits = [terms.address, terms.name, terms.symbol]
    .filter((needle) => needle.length >= MIN_SYMBOL_CHARS)
    .map((needle) => lower.indexOf(needle.toLowerCase()))
    .filter((i) => i >= 0);
  const first = hits.length > 0 ? Math.min(...hits) : 0;
  if (first < max * 0.6) return clip(text, max);
  const from = first - EXCERPT_LEAD_CHARS;
  const space = text.indexOf(' ', from);
  const start = space >= 0 && space < first ? space + 1 : from;
  return '…' + clip(text.slice(start), max - 1);
}

/** Host + decoded path of a URL, so slugs such as "/bonk-rallies" count as text. */
export function urlText(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname} ${safeDecode(u.pathname)}`;
  } catch {
    return '';
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function stableId(provider: string, key: string): string {
  return `${provider}:${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
}
