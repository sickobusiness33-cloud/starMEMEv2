import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntelItem, TokenSnapshot } from '../../shared/types.js';
import { researchWeb, webResearchEnabled } from '../src/ai/web-research.js';
import * as biz from '../src/research/intel/biz.js';
import { buildGdeltQuery, decodeGdeltBody, parseGdeltArticles } from '../src/research/intel/gdelt.js';
import * as gdelt from '../src/research/intel/gdelt.js';
import * as hn from '../src/research/intel/hn.js';
import {
  dedupeByUrl,
  filterRelevant,
  gatherIntel,
  normalizeUrl,
  quickMentions,
  rankIntel,
  resetIntelState,
} from '../src/research/intel/index.js';
import { intelTerms, type IntelQuery } from '../src/research/intel/match.js';
import { officialItems } from '../src/research/intel/official.js';
import { emptySnapshot } from '../src/sources/merge.js';

// Only the network-facing search() functions are replaced; the pure parsers stay real.
vi.mock('../src/research/intel/gdelt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/research/intel/gdelt.js')>()),
  search: vi.fn(),
}));
vi.mock('../src/research/intel/hn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/research/intel/hn.js')>()),
  search: vi.fn(),
}));
vi.mock('../src/research/intel/biz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/research/intel/biz.js')>()),
  search: vi.fn(),
}));
vi.mock('../src/ai/web-research.js', () => ({ researchWeb: vi.fn(), webResearchEnabled: vi.fn(() => true) }));

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const MIN = 60_000;
const HOUR = 60 * MIN;
/** shortly after the fixtures were captured */
const NOW = Date.UTC(2026, 9, 1, 21, 10);
const BONK_ADDRESS = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PEPE_ETH = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';

function query(symbol: string, name: string, address = BONK_ADDRESS): IntelQuery {
  return { symbol, name, address, chain: address.startsWith('0x') ? 'ethereum' : 'solana', links: [] };
}

const BONK = query('BONK', 'Bonk');

function item(over: Partial<IntelItem> & Pick<IntelItem, 'title' | 'url'>): IntelItem {
  return {
    id: over.url,
    sourceName: 'example.com',
    sourceType: 'news',
    provider: 'gdelt',
    publishedAt: null,
    freshness: 'UNKNOWN',
    snippet: null,
    matchedOn: 'symbol',
    ...over,
  };
}

/* ───────────────────────────── GDELT ───────────────────────────── */

describe('GDELT', () => {
  it('maps the artlist fixture', () => {
    const items = parseGdeltArticles(fixture('gdelt_solana.json'), NOW);
    expect(items).toHaveLength(10);
    expect(items[0]).toEqual({
      id: expect.stringMatching(/^gdelt:[0-9a-f]{16}$/),
      title: 'Best Crypto to Buy in October 2026: Bitcoin, Ethereum, XRP, Solana, and High - Potential Alternatives',
      url: 'https://www.aol.com/articles/best-crypto-buy-october-2026-183015000.html',
      sourceName: 'aol.com',
      sourceType: 'news',
      provider: 'gdelt',
      publishedAt: Date.UTC(2026, 9, 1, 19, 45),
      freshness: 'RECENT',
      snippet: null,
      matchedOn: 'name',
    });
    const coindesk = items.find((i) => i.sourceName === 'coindesk.com');
    expect(coindesk?.sourceType).toBe('specialized');
    expect(coindesk?.publishedAt).toBe(Date.UTC(2026, 9, 1, 17, 30));
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('classifies blogs and skips articles without url or title', () => {
    const json = {
      articles: [
        { url: 'https://someone.substack.com/p/bonk', title: 'Bonk notes', seendate: '20261001T204000Z', domain: 'someone.substack.com' },
        { url: 'https://medium.com/@x/bonk', title: 'Bonk essay', seendate: 'garbage', domain: 'medium.com' },
        { url: '', title: 'no url' },
        { url: 'https://example.com/a', title: '   ' },
      ],
    };
    const items = parseGdeltArticles(json, NOW);
    expect(items.map((i) => [i.sourceType, i.freshness])).toEqual([
      ['blog', 'LIVE'],
      ['blog', 'UNKNOWN'],
    ]);
    expect(items[1]?.publishedAt).toBeNull();
  });

  it('turns GDELT plain-text answers into errors and tolerates sloppy JSON', () => {
    expect(() => decodeGdeltBody('Please limit requests to one every 5 seconds or contact us.')).toThrow(
      /GDELT: Please limit requests/,
    );
    expect(() => decodeGdeltBody('The specified phrase is too short.')).toThrow(/phrase is too short/);
    expect(decodeGdeltBody('')).toEqual({});
    expect(decodeGdeltBody('{}')).toEqual({});
    const sloppy = '{"articles": [{"url": "https://e.com/a", "title": "Bonk\'s \\\'run\'\n rally", "seendate": "20261001T200000Z"}]}';
    expect(parseGdeltArticles(decodeGdeltBody(sloppy), NOW)[0]?.title).toBe("Bonk's 'run' rally");
  });

  it('builds queries GDELT accepts', () => {
    const context = '(crypto OR cryptocurrency OR token OR memecoin OR blockchain OR defi)';
    // single words stay bare: GDELT rejects a quoted single word as "phrase too short"
    expect(buildGdeltQuery(intelTerms(BONK))).toBe(`(Bonk OR ${BONK_ADDRESS}) ${context}`);
    expect(buildGdeltQuery(intelTerms(query('BONKINU', 'Bonk Inu')))).toBe(
      `("Bonk Inu" OR BONKINU OR ${BONK_ADDRESS}) ${context}`,
    );
    // ambiguous words are only searched in ticker form
    expect(buildGdeltQuery(intelTerms(query('CAT', 'Cat')))).toBe(
      `("Cat coin" OR "Cat token" OR ${BONK_ADDRESS}) ${context}`,
    );
    expect(buildGdeltQuery(intelTerms(query('WIF', 'dogwifhat')))).toBe(
      `(dogwifhat OR "WIF coin" OR "WIF token" OR ${BONK_ADDRESS}) ${context}`,
    );
    // nothing searchable but the address: no context group, no parentheses
    expect(buildGdeltQuery(intelTerms(query('AI', 'AI')))).toBe(BONK_ADDRESS);
    // operators in names cannot break the query
    expect(buildGdeltQuery(intelTerms(query('X', '"Moo" (Deng) OR')))).toBe(`("Moo Deng OR" OR ${BONK_ADDRESS}) ${context}`);
  });
});

/* ───────────────────────────── Hacker News ───────────────────────────── */

describe('Hacker News', () => {
  it('maps story hits from the fixture', () => {
    const items = hn.parseHnHits(fixture('hn_search_solana.json'), NOW);
    expect(items).toHaveLength(10);
    expect(items[0]).toEqual({
      id: 'hn:49898958',
      title: 'Show HN: Sarala – An open-source WYSIWYG Markdown editor',
      url: 'https://sarala.solancer.com/',
      sourceName: 'Hacker News',
      sourceType: 'article',
      provider: 'hn',
      publishedAt: 1790709704000,
      freshness: 'OLD',
      snippet: null,
      matchedOn: 'name',
    });
    const raven = items.find((i) => i.id === 'hn:49620394');
    expect(raven?.snippet).toMatch(/^Solo dev\. built in my spare time\. Raven uses/);
    expect(raven?.snippet).not.toContain('<p>');
    expect(raven?.snippet?.length).toBeLessThanOrEqual(220);
  });

  it('maps comments to the comment itself with a clean snippet', () => {
    const longTail = ' filler'.repeat(60);
    const json = {
      hits: [
        {
          _tags: ['comment', 'author_x', 'story_1'],
          objectID: '777',
          created_at: '2026-10-01T20:50:00Z',
          created_at_i: Math.floor((NOW - 20 * MIN) / 1000),
          comment_text: `I&#x27;m watching <i>$BONK</i> on Solana.<p>${longTail}`,
          story_title: 'Memecoins are back',
          story_url: 'https://example.com/memecoins',
        },
        { _tags: ['story'], objectID: '778', title: 'Ask HN: Bonk?', url: null, created_at: '2026-10-01T10:00:00Z' },
        { _tags: ['comment'], objectID: '779', comment_text: '' },
      ],
    };
    const [comment, ask] = hn.parseHnHits(json, NOW, 'symbol');
    expect(comment).toMatchObject({
      id: 'hn:777',
      title: 'Re: Memecoins are back',
      url: 'https://news.ycombinator.com/item?id=777',
      sourceType: 'community',
      freshness: 'LIVE',
      matchedOn: 'symbol',
    });
    expect(comment?.snippet?.startsWith("I'm watching $BONK on Solana. filler")).toBe(true);
    expect(comment?.snippet?.length).toBeLessThanOrEqual(220);
    expect(ask).toMatchObject({
      url: 'https://news.ycombinator.com/item?id=778',
      sourceType: 'community',
      publishedAt: Date.UTC(2026, 9, 1, 10),
    });
  });

  it('does not title a comment after a moderated story placeholder', () => {
    const json = {
      hits: [{ _tags: ['comment'], objectID: '9', comment_text: 'dogwifhat again', story_title: '[dead]', created_at_i: 1790700000 }],
    };
    expect(hn.parseHnHits(json, NOW)[0]?.title).toBe('Hacker News comment');
  });

  it('centres long snippets on the mention', () => {
    const text = `${'Lorem ipsum dolor sit amet. '.repeat(20)}Then someone posted the Bonk contract.`;
    const json = { hits: [{ _tags: ['comment'], objectID: '1', comment_text: text, created_at_i: 1790700000 }] };
    const [c] = hn.parseHnHits(json, NOW, 'name', intelTerms(BONK));
    expect(c?.snippet).toMatch(/^….*Bonk contract\.$/);
  });
});

/* ───────────────────────────── /biz/ ───────────────────────────── */

describe('/biz/ catalog', () => {
  const catalog = fixture('biz_catalog.json');

  it('matches the $SYMBOL cashtag but not the bare ticker', () => {
    const threads = [
      { no: 1, time: 1790847970, com: 'Loading up on $WOJAKX before the weekend' },
      { no: 2, time: 1790847971, com: 'wojakx is a meme from 2021' },
    ];
    const items = biz.parseBizCatalog([{ page: 1, threads }], query('WOJAKX', 'Wojak Extreme'), NOW);
    expect(items).toEqual([
      {
        id: 'biz:1',
        title: 'Loading up on $WOJAKX before the weekend',
        url: 'https://boards.4chan.org/biz/thread/1',
        sourceName: '/biz/',
        sourceType: 'forum',
        provider: 'biz',
        publishedAt: 1790847970000,
        freshness: 'RECENT',
        snippet: 'Loading up on $WOJAKX before the weekend',
        matchedOn: 'symbol',
      },
    ]);
  });

  it("never credits a short ticker's cashtag to a token without its name, chain or contract", () => {
    // live: a 3-letter ticker is shared by many tokens; "$QNT" alone is about the famous one
    expect(biz.parseBizCatalog(catalog, query('QNT', 'Qnt'), NOW)).toEqual([]);
    const withName = biz.parseBizCatalog(
      [{ page: 1, threads: [{ no: 3, time: 1790847970, com: 'Quant ($QNT) is the interoperability play' }] }],
      query('QNT', 'Quant'),
      NOW,
    );
    expect(withName.map((i) => i.matchedOn)).toEqual(['symbol']);
  });

  it('matches the exact name in subject or post, with HTML stripped and entities decoded', () => {
    const [monero] = biz.parseBizCatalog(catalog, query('XMR', 'Monero'), NOW);
    expect(monero).toMatchObject({ id: 'biz:62720365', title: '/XMR/ Monero General', matchedOn: 'name' });
    expect(monero?.snippet).toContain("world's most widely adopted");
    expect(monero?.snippet).not.toMatch(/<|&#039;/);
  });

  it('finds a contract address split by <wbr>, caps at 15, most active first', () => {
    const threads = Array.from({ length: 20 }, (_, i) => ({
      no: 1000 + i,
      time: 1790880000 + i,
      last_modified: 1790890000 + i,
      com: `CA: DezXAZ8z7PnrnRJjz3wXBoR<wbr>gixCa6xjnB7YaB1pPB263 thread ${i}`,
    }));
    const items = biz.parseBizCatalog([{ page: 1, threads }], BONK, NOW);
    expect(items).toHaveLength(15);
    expect(items[0]).toMatchObject({ id: 'biz:1019', matchedOn: 'contract', publishedAt: 1790880019000 });
    expect(items.every((i) => i.matchedOn === 'contract')).toBe(true);
  });
});

/* ───────────────────────────── official links ───────────────────────────── */

describe('official links', () => {
  it('turns website / X / Telegram / Discord into undated project items', () => {
    const items = officialItems([
      { type: 'website', url: 'https://www.bonkcoin.com/' },
      { type: 'twitter', url: 'https://x.com/bonk_inu' },
      { type: 'telegram', url: 'https://t.me/bonkinu' },
      { type: 'discord', url: 'https://discord.gg/bonk' },
      { type: 'other', url: 'https://tiktok.com/@bonk' },
      { type: 'website', url: 'javascript:alert(1)' },
    ]);
    expect(items.map((i) => [i.title, i.sourceName])).toEqual([
      ['Project website', 'bonkcoin.com'],
      ['Project X (Twitter) account @bonk_inu', 'x.com'],
      ['Project Telegram', 't.me'],
      ['Project Discord', 'discord.gg'],
    ]);
    for (const i of items) {
      expect(i).toMatchObject({ sourceType: 'official', provider: 'dexscreener', publishedAt: null, freshness: 'UNKNOWN', matchedOn: 'project' });
    }
  });
});

/* ───────────────────────────── relevance ───────────────────────────── */

describe('relevance filter', () => {
  it('rejects a short / generic symbol without corroboration', () => {
    const ai = query('AI', 'AI');
    const kept = filterRelevant(
      [
        item({ title: 'AI agents are eating software', url: 'https://example.com/ai-agents' }),
        item({ title: 'The $AI token is up', url: 'https://example.com/1' }), // 2-char symbols never match
        item({ title: 'New listing', url: `https://dexscreener.com/solana/${BONK_ADDRESS}`, provider: 'hn' }),
      ],
      ai,
      NOW,
    );
    expect(kept.map((i) => [i.url, i.matchedOn])).toEqual([[`https://dexscreener.com/solana/${BONK_ADDRESS}`, 'contract']]);
  });

  it('drops "pepe" chatter for a generic PEPE token: a cashtag or ticker form needs the chain or the contract', () => {
    const pepe = query('PEPE', 'Pepe', PEPE_ETH);
    expect(biz.parseBizCatalog(fixture('biz_catalog.json'), pepe, NOW)).toEqual([]);

    const kept = filterRelevant(
      [
        item({ title: 'Loading up on $pepe again', url: 'https://example.com/a', provider: 'biz' }),
        item({ title: 'Pepe (PEPE) price analysis', url: 'https://example.com/b', provider: 'hn' }),
        item({ title: 'Why the PEPE coin keeps running', url: 'https://example.com/c', provider: 'hn' }),
        item({ title: 'Contract check', url: 'https://example.com/d', provider: 'hn', snippet: `ca ${PEPE_ETH.toLowerCase()}` }),
        item({ title: '$PEPE leads Ethereum memecoins', url: 'https://example.com/e', provider: 'hn' }),
        item({ title: 'Pepe (PEPE), the ERC-20 frog', url: 'https://example.com/f', provider: 'gdelt' }),
      ],
      pepe,
      NOW,
    );
    expect(kept.map((i) => [i.url.slice(-1), i.matchedOn])).toEqual([
      ['d', 'contract'],
      ['e', 'symbol'],
      ['f', 'symbol'],
    ]);
  });

  it('a copycat launched minutes ago does not inherit the famous ticker\'s chatter', () => {
    // live: intelTerms({symbol:'CAT'}).match('$CAT is sending, best memecoin on base') was 'symbol' for a Solana CAT
    const cat = query('CAT', 'Cat');
    expect(intelTerms(cat).match('$CAT is sending, best memecoin on base')).toBeNull();
    expect(intelTerms(cat).match('CAT coin pumps')).toBeNull();
    expect(intelTerms(cat).match('$CAT on Solana is sending')).toBe('symbol');
    expect(intelTerms({ ...cat, chain: 'base' }).match('$CAT is sending, best memecoin on base')).toBe('symbol');
  });

  it('ignores look-alike words that full-text search returns (Solar, Solaar, solancer)', () => {
    const hits = hn.parseHnHits(fixture('hn_search_solana.json'), NOW);
    // the word appears only inside other words or as an ambiguous ticker ("BTC/Sol")
    expect(filterRelevant(hits, query('SOL', 'Solana'), NOW)).toEqual([]);
    // a distinctive name also matches URL slugs; "on-chain" gives the crypto context HN needs
    const permissioned = filterRelevant(hits, query('PTKN', 'Permissioned Tokens'), NOW);
    expect(permissioned.map((i) => [i.id, i.matchedOn])).toEqual([['hn:49519891', 'name']]);
    // "cryptography" is not crypto context, but this story also says it "stores the ciphertext on Solana"
    const raven = filterRelevant(hits, query('RAVEN', 'Raven'), NOW);
    expect(raven.map((i) => [i.id, i.matchedOn])).toEqual([['hn:49620394', 'name']]);
  });

  it('needs crypto context for a bare name on Hacker News, not on /biz/', () => {
    const verb = "I mean there's also Bonk but at least this has an open source server";
    const kept = filterRelevant(
      [
        item({ title: 'Re: Show HN: Boop', url: 'https://news.ycombinator.com/item?id=1', provider: 'hn', snippet: verb }),
        item({ title: 'Re: Semaglutide', url: 'https://news.ycombinator.com/item?id=2', provider: 'hn', snippet: 'people bonk on long rides' }),
        item({ title: 'Re: Memecoins', url: 'https://news.ycombinator.com/item?id=3', provider: 'hn', snippet: 'Bonk is the top memecoin on Solana' }),
        item({ title: 'Re: Tokens', url: 'https://news.ycombinator.com/item?id=4', provider: 'hn', snippet: 'I bought some $BONK' }),
        item({ title: verb, url: 'https://boards.4chan.org/biz/thread/5', provider: 'biz' }),
      ],
      BONK,
      NOW,
    );
    expect(kept.map((i) => [i.url.slice(-1), i.matchedOn])).toEqual([
      ['3', 'name'],
      ['4', 'symbol'],
      ['5', 'name'],
    ]);
  });

  it('trusts full-text providers only for distinctive terms, and never raw web-search hits', () => {
    const untitled = (provider: string) =>
      item({ title: 'Top memecoins to watch this week', url: `https://news.example/${provider}`, provider, matchedOn: 'name' });
    // GDELT matched the query in the article's full text; a web-search hit is only the engine's raw result
    const bonk = filterRelevant([untitled('gdelt'), untitled('hn'), untitled('claude-web')], BONK, NOW);
    expect(bonk.map((i) => i.provider)).toEqual(['gdelt']);
    const cat = filterRelevant([untitled('gdelt'), untitled('claude-web')], query('CAT', 'Cat'), NOW);
    expect(cat).toEqual([]);
  });

  it('keeps official links and recomputes freshness against now', () => {
    const [own] = officialItems([{ type: 'website', url: 'https://bonkcoin.com' }]);
    const stale = item({ title: 'Bonk rallies', url: 'https://e.com/x', provider: 'biz', publishedAt: NOW - 30 * MIN, freshness: 'OLD' });
    const kept = filterRelevant([own!, stale], query('ZZZ', 'Unrelated'), NOW);
    expect(kept.map((i) => i.matchedOn)).toEqual(['project']);
    expect(filterRelevant([stale], BONK, NOW)[0]).toMatchObject({ freshness: 'LIVE', matchedOn: 'name' });
  });
});

/* ───────────────────────────── dedupe & ranking ───────────────────────────── */

describe('dedupe and ranking', () => {
  it('normalizes URLs', () => {
    expect(normalizeUrl('https://WWW.CoinDesk.com/markets/bonk/?utm_source=x&utm_medium=y&id=3#top')).toBe(
      'coindesk.com/markets/bonk?id=3',
    );
    expect(normalizeUrl('http://coindesk.com/markets/bonk')).toBe('coindesk.com/markets/bonk');
  });

  it('merges duplicates keeping the richest fields', () => {
    const a = item({ title: 'Bonk', url: 'https://coindesk.com/bonk/', matchedOn: 'symbol' });
    const b = item({
      title: 'Bonk',
      url: 'https://www.coindesk.com/bonk?utm_campaign=z',
      provider: 'claude-web',
      publishedAt: NOW - HOUR,
      freshness: 'LIVE',
      snippet: 'Bonk rallies',
      matchedOn: 'contract',
    });
    expect(dedupeByUrl([a, b])).toEqual([
      { ...a, publishedAt: NOW - HOUR, freshness: 'LIVE', snippet: 'Bonk rallies', matchedOn: 'contract' },
    ]);
  });

  it('sorts newest first, undated after dated, official last, capped at 60', () => {
    const dated = Array.from({ length: 70 }, (_, i) =>
      item({ title: `n${i}`, url: `https://e.com/${i}`, publishedAt: NOW - i * MIN }),
    );
    const undated = item({ title: 'undated', url: 'https://e.com/undated' });
    const own = officialItems([{ type: 'website', url: 'https://bonkcoin.com' }]);
    const ranked = rankIntel([undated, ...own, ...[...dated].reverse()]);
    expect(ranked).toHaveLength(60);
    expect(ranked[0]?.title).toBe('n0');
    expect(ranked[58]?.title).toBe('n58');
    expect(ranked[59]?.sourceType).toBe('official');
    expect(rankIntel([own[0]!, undated, dated[3]!]).map((i) => i.title)).toEqual(['n3', 'undated', 'Project website']);
  });
});

/* ───────────────────────────── orchestration ───────────────────────────── */

describe('gatherIntel', () => {
  beforeEach(() => {
    vi.mocked(gdelt.search).mockReset();
    vi.mocked(hn.search).mockReset();
    vi.mocked(biz.search).mockReset();
    vi.mocked(researchWeb).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves Claude web research out of the run and the status list when it is not configured', async () => {
    vi.mocked(webResearchEnabled).mockReturnValueOnce(false);
    vi.mocked(gdelt.search).mockResolvedValue([]);
    vi.mocked(hn.search).mockResolvedValue([]);
    vi.mocked(biz.search).mockResolvedValue([]);
    const { providers } = await gatherIntel(BONK, NOW);
    expect(providers.map((p) => p.provider)).toEqual(['gdelt', 'hn', 'biz', 'official']);
    expect(researchWeb).not.toHaveBeenCalled();
  });

  it('runs every provider, filters, dedupes and reports per-provider status', async () => {
    vi.mocked(gdelt.search).mockResolvedValue([
      item({ title: 'Bonk leads memecoin rebound', url: 'https://coindesk.com/bonk?utm_source=gdelt', publishedAt: NOW - 2 * HOUR }),
      item({ title: 'Cats of the internet', url: 'https://pets.example/cats', matchedOn: 'name' }),
    ]);
    vi.mocked(hn.search).mockRejectedValue(new Error('HTTP 503 from hn.algolia.com/api/v1/search_by_date'));
    vi.mocked(biz.search).mockResolvedValue([
      item({ title: 'BONK thread', url: 'https://boards.4chan.org/biz/thread/1', provider: 'biz', sourceType: 'forum', publishedAt: NOW - 5 * MIN, snippet: `ca ${BONK_ADDRESS}` }),
    ]);
    vi.mocked(researchWeb).mockResolvedValue([
      item({ title: 'Bonk leads memecoin rebound', url: 'https://www.coindesk.com/bonk', provider: 'claude-web', publishedAt: NOW - 2 * HOUR }),
    ]);

    const t = { ...BONK, links: [{ type: 'website' as const, url: 'https://bonkcoin.com' }] };
    const { items, providers } = await gatherIntel(t, NOW);

    expect(providers).toEqual([
      { provider: 'gdelt', ok: true, count: 2, error: null }, // "Cats" is kept: GDELT matched "Bonk" in the full text
      { provider: 'hn', ok: false, count: 0, error: 'HTTP 503 from hn.algolia.com/api/v1/search_by_date' },
      { provider: 'biz', ok: true, count: 1, error: null },
      { provider: 'official', ok: true, count: 1, error: null },
      { provider: 'claude-web', ok: true, count: 1, error: null },
    ]);
    expect(items.map((i) => [i.provider, i.matchedOn, i.freshness])).toEqual([
      ['biz', 'contract', 'LIVE'],
      ['gdelt', 'name', 'RECENT'],
      ['gdelt', 'name', 'UNKNOWN'],
      ['dexscreener', 'project', 'UNKNOWN'],
    ]);
    expect(researchWeb).toHaveBeenCalledWith(
      { chain: 'solana', address: BONK_ADDRESS, symbol: 'BONK', name: 'Bonk' },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('reports a failed web research as a failure, not as zero mentions', async () => {
    vi.mocked(gdelt.search).mockResolvedValue([]);
    vi.mocked(hn.search).mockRejectedValue(new Error('down'));
    vi.mocked(biz.search).mockRejectedValue(new Error('down'));
    vi.mocked(researchWeb).mockRejectedValue(new Error('web research failed: Anthropic API rate limit reached (429)'));
    const { providers } = await gatherIntel(BONK, NOW);
    expect(providers.find((p) => p.provider === 'claude-web')).toEqual({
      provider: 'claude-web',
      ok: false,
      count: 0,
      error: 'web research failed: Anthropic API rate limit reached (429)',
    });
  });

  it('skips web research with its reason, or leaves it out when turned off', async () => {
    vi.mocked(gdelt.search).mockResolvedValue([]);
    vi.mocked(hn.search).mockResolvedValue([]);
    vi.mocked(biz.search).mockResolvedValue([]);
    const skipped = await gatherIntel(BONK, NOW, { webResearch: { run: false, reason: 'hourly AI budget reached' } });
    expect(skipped.providers.at(-1)).toEqual({ provider: 'claude-web', ok: false, count: 0, error: 'not run: hourly AI budget reached' });
    const off = await gatherIntel(BONK, NOW, { webResearch: { run: false, reason: null } });
    expect(off.providers.map((p) => p.provider)).not.toContain('claude-web');
    expect(researchWeb).not.toHaveBeenCalled();
  });

  it('cancels a timed-out provider instead of letting it run on', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.mocked(researchWeb).mockImplementation((_t, o) => {
      signal = o?.signal;
      return new Promise(() => {});
    });
    vi.mocked(gdelt.search).mockResolvedValue([]);
    vi.mocked(hn.search).mockResolvedValue([]);
    vi.mocked(biz.search).mockResolvedValue([]);
    const pending = gatherIntel(BONK, NOW);
    await vi.advanceTimersByTimeAsync(60_000);
    const { providers } = await pending;
    expect(providers.find((p) => p.provider === 'claude-web')?.error).toBe('claude-web timed out after 60s');
    expect(signal?.aborted).toBe(true);
  });

  it('times out a hanging provider without failing the others', async () => {
    vi.useFakeTimers();
    vi.mocked(gdelt.search).mockReturnValue(new Promise(() => {}));
    vi.mocked(hn.search).mockResolvedValue([]);
    vi.mocked(biz.search).mockImplementation(() => {
      throw new Error('sync failure');
    });
    vi.mocked(researchWeb).mockResolvedValue([]);
    const pending = gatherIntel(BONK, NOW);
    await vi.advanceTimersByTimeAsync(20_000);
    const { providers } = await pending;
    expect(providers.find((p) => p.provider === 'gdelt')).toEqual({
      provider: 'gdelt',
      ok: false,
      count: 0,
      error: 'gdelt timed out after 20s',
    });
    expect(providers.find((p) => p.provider === 'biz')?.error).toBe('sync failure');
    expect(providers.find((p) => p.provider === 'hn')?.ok).toBe(true);
  });
});

describe('quickMentions', () => {
  const snapshot: TokenSnapshot = { ...emptySnapshot('solana', BONK_ADDRESS, NOW), symbol: 'BONK', name: 'Bonk' };

  beforeEach(() => {
    resetIntelState();
    vi.mocked(gdelt.search).mockReset();
    vi.mocked(hn.search).mockReset();
    vi.mocked(biz.search).mockReset();
  });

  it('counts relevant hn + /biz/ mentions from the last 2 hours, cached per token', async () => {
    const now = Date.now();
    vi.mocked(hn.search).mockResolvedValue([
      item({ title: 'Bonk, the Solana memecoin', url: 'https://hn.example/1', provider: 'hn', publishedAt: now - 30 * MIN }),
      item({ title: 'Bonk last week', url: 'https://hn.example/2', provider: 'hn', publishedAt: now - 7 * 24 * HOUR }),
      item({ title: 'Unrelated', url: 'https://hn.example/3', provider: 'hn', publishedAt: now - MIN }),
    ]);
    vi.mocked(biz.search).mockResolvedValue([
      item({ title: '$BONK general', url: 'https://boards.4chan.org/biz/thread/9', provider: 'biz', publishedAt: now - 90 * MIN }),
      item({ title: '$BONK undated', url: 'https://boards.4chan.org/biz/thread/10', provider: 'biz' }),
    ]);
    // only the name mention counts: a cashtag alone may be about another token with the same ticker
    expect(await quickMentions(snapshot)).toBe(1);
    expect(await quickMentions({ ...snapshot, ts: NOW + 1 })).toBe(1);
    expect(hn.search).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hn.search).mock.calls[0]?.[1]).toEqual({ includeAddress: false, signal: expect.any(AbortSignal) });
    expect(gdelt.search).not.toHaveBeenCalled();
  });

  it('is null only when no provider answered', async () => {
    vi.mocked(hn.search).mockRejectedValue(new Error('down'));
    vi.mocked(biz.search).mockRejectedValue(new Error('down'));
    expect(await quickMentions(snapshot)).toBeNull();

    resetIntelState();
    vi.mocked(biz.search).mockResolvedValue([]);
    expect(await quickMentions(snapshot)).toBe(0);
  });
});
