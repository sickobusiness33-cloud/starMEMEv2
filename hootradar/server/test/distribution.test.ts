import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardMetrics, DistributionItem, NewsArticle, TokenSnapshot } from '../../shared/types.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import {
  articleUrl,
  escapeHtml,
  formatDiscord,
  formatForChannels,
  formatTelegram,
  formatWebhook,
  formatX,
  X_LIMIT,
  xLength,
} from '../src/distribution/formats.js';
import { DistributionQueue } from '../src/distribution/queue.js';
import { parseDsPairs } from '../src/sources/dexscreener.js';

const T0 = Date.UTC(2026, 9, 1, 21, 11);
const BASE_URL = 'https://hootradar.example';

/** Bonk as returned by the real DexScreener tokens endpoint. */
function bonk(): TokenSnapshot {
  const json = JSON.parse(readFileSync(new URL('./fixtures/ds_tokens_solana.json', import.meta.url), 'utf8'));
  const s = parseDsPairs(json, 'solana', T0).find((x) => x.symbol === 'Bonk');
  if (!s) throw new Error('fixture changed');
  return s;
}

function cardMetrics(s: TokenSnapshot): CardMetrics {
  return {
    priceUsd: s.priceUsd,
    marketCapUsd: s.marketCapUsd ?? s.fdvUsd,
    mcIsFdv: s.marketCapUsd == null && s.fdvUsd != null,
    liquidityUsd: s.liquidityUsd,
    volumeUsd: s.volumeUsd.h1 ?? null,
    volumeWindow: s.volumeUsd.h1 != null ? 'h1' : null,
    txPerMin: 4,
    buyPct: 37.4,
    sellPct: 62.6,
    holders: 1024516,
    holdersGrowthPct: null,
    priceChangeH1Pct: s.priceChangePct.h1 ?? null,
    ageMinutes: null,
  };
}

function article(over: Partial<NewsArticle> = {}): NewsArticle {
  const s = bonk();
  return {
    id: 'art-1',
    createdAt: T0,
    chain: 'solana',
    address: s.address,
    symbol: s.symbol,
    name: s.name,
    imageUrl: s.imageUrl,
    severity: 'BREAKING',
    score: 81,
    headline: 'Volume spike in $Bonk: 5-min flow running at 4.2x the hourly average',
    lede: '$Bonk (Solana) is seeing a sharp acceleration in trading volume. 1h volume has reached $15K and transactions are running at 3.1x the hourly average.',
    aiLine: 'The token is showing an abnormal acceleration in trading volume over the last few minutes.',
    whyItMatters: ['Reason one.', 'Reason two.', 'Reason three.'],
    quantAnalysis: 'Current conditions resemble Time-series momentum (72%).',
    outlook: { bullish: 'If volume holds, activity could extend.', neutral: 'Price could move sideways.', risk: 'A liquidity pull could erase the move.' },
    engine: 'rules',
    model: null,
    lang: 'en',
    metrics: cardMetrics(s),
    signals: [],
    quant: {
      top: { methodologyId: 'tsmom', name: 'Time-series momentum', family: 'momentum', score: 72.4, coverage: 0.9, rationale: '', factors: [] },
      matches: [],
      regime: { label: 'risk-on', breadthPct: 61, medianH1ChangePct: 3, sampleSize: 100, computedAt: T0 },
      riskFlags: [],
    },
    pipeline: { detectedAt: T0, analyzedAt: T0, quantAt: T0, writtenAt: T0, publishedAt: T0 },
    links: {
      dexscreener: `https://dexscreener.com/solana/${s.address}`,
      explorer: `https://solscan.io/token/${s.address}`,
      website: null,
      twitter: null,
      telegram: null,
    },
    updateOf: null,
    ...over,
  };
}

/* ───────────── formats ───────────── */

describe('channel formats', () => {
  it('renders one payload per channel', () => {
    expect(formatForChannels(article(), BASE_URL).map((p) => p.channel)).toEqual(['x', 'telegram', 'discord', 'webhook']);
    expect(articleUrl({ id: 'a b' }, `${BASE_URL}/`)).toBe(`${BASE_URL}/#/live?article=a%20b`);
    expect(articleUrl({ id: 'a' }, null)).toBeNull();
    expect(articleUrl({ id: 'a' }, 'javascript:alert(1)')).toBeNull();
  });

  it('builds an X post with header, lede, figures and link', () => {
    const post = formatX(article(), articleUrl(article(), BASE_URL));
    const lines = post.split('\n');
    expect(lines[0]).toBe('🚨 BREAKING — $Bonk (Solana)');
    expect(lines[1]).toContain('$Bonk (Solana) is seeing');
    expect(lines[2]).toBe('MC $331M · Vol 1h $15K · Tx/min 4');
    expect(lines[3]).toBe(`${BASE_URL}/#/live?article=art-1`);
    expect(xLength(post)).toBeLessThanOrEqual(X_LIMIT);
    expect(formatX(article({ severity: 'ALERT' }), null).split('\n')[0]).toBe('⚡ ALERT — $Bonk (Solana)');
    // without a public URL the chart link is used
    expect(formatX(article(), null)).toContain('https://dexscreener.com/solana/');
  });

  it('counts URLs as 23 and wide characters as 2', () => {
    expect(xLength('see https://example.com/a/very/long/path/that/keeps/going')).toBe(4 + 23);
    expect(xLength('🚨 ok')).toBe(5);
    expect(xLength('日本')).toBe(4);
    expect(xLength('— ·')).toBe(3);
  });

  it('keeps X posts within 280 weighted characters in worst cases', () => {
    const word = (n: number) => 'Supercalifragilistic'.repeat(4).slice(0, n);
    const ledes = [
      'x'.repeat(320),
      `${word(70)} ${word(70)} ${word(70)} ${word(70)}`,
      '日本語のトークン説明'.repeat(30),
      '🚀'.repeat(200),
      `First sentence is short. ${'Second sentence is very long and keeps going '.repeat(8)}`,
      `Visit https://example.com/${'p'.repeat(200)} now ${'z'.repeat(250)}`,
    ];
    for (const lede of ledes) {
      for (const symbol of ['B', 'S'.repeat(60), '🐸'.repeat(30), 'トークン'.repeat(10)]) {
        const a = article({ lede, symbol, name: 'N'.repeat(200), chain: 'an-unregistered-chain-with-a-long-name' });
        for (const link of [articleUrl(a, `${BASE_URL}/${'deep/'.repeat(40)}`), null]) {
          const post = formatX(a, link);
          expect(xLength(post), post).toBeLessThanOrEqual(X_LIMIT);
          expect(post.length).toBeGreaterThan(10);
        }
      }
    }
  });

  it('cuts the X lede at a sentence boundary when one fits', () => {
    const lede = `$Bonk (Solana) is seeing a sharp acceleration in trading volume. ${'More detail follows here. '.repeat(10)}`;
    const post = formatX(article({ lede }), articleUrl(article(), BASE_URL));
    expect(post.split('\n')[1]).toMatch(/\.$/);
    expect(xLength(post)).toBeLessThanOrEqual(X_LIMIT);
  });

  it('never drops a sentence that contains a decimal figure', () => {
    // live regression: "…alcanza $2.1M y la actividad…" did not match the sentence regex, so it was
    // skipped and the post read "…para su edad. 1M y la actividad…"
    const first = '$RAMCAT, lanzado hace 33 min en Solana, registra un volumen de negociación muy intenso para su edad. ';
    const second =
      'El volumen acumulado desde su lanzamiento en todos los pools de la red ya alcanza los $2.1M en total y sigue.';
    const post = formatX(article({ lede: first + second }), articleUrl(article(), BASE_URL));
    const lede = post.split('\n')[1] ?? '';
    expect(lede.startsWith('$RAMCAT, lanzado hace 33 min')).toBe(true);
    expect(lede).not.toMatch(/\. 1M\b/);
    expect(lede).not.toContain('1M en total'); // the whole second sentence does not fit, so none of it may appear
    expect(xLength(post)).toBeLessThanOrEqual(X_LIMIT);
  });

  it('escapes provider text for Telegram HTML', () => {
    const msg = formatTelegram(
      article({ symbol: '<b>EVIL', headline: 'Rug <script>alert("x")</script> & co', aiLine: 'a < b > c' }),
      `${BASE_URL}/#/live?article=1&x="2"`,
    );
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co');
    expect(msg).toContain('<i>a &lt; b &gt; c</i>');
    expect(msg).toContain('$&lt;b&gt;EVIL');
    expect(msg).toContain(`<a href="${BASE_URL}/#/live?article=1&amp;x=&quot;2&quot;">Read on HootRadar</a>`);
    expect(msg).toContain('• Reason one.');
    expect(msg).toContain('Buy/Sell 37% / 63%');
    expect(msg).toContain('<i>Not financial advice.</i>');
    // only the tags we emit remain
    const tags = new Set([...msg.matchAll(/<\/?([a-z]+)/g)].map((m) => m[1]));
    expect([...tags].sort()).toEqual(['a', 'b', 'i']);
    expect(escapeHtml('&<>"')).toBe('&amp;&lt;&gt;&quot;');
  });

  it('localizes Telegram labels', () => {
    const msg = formatTelegram(article({ lang: 'es' }), null);
    expect(msg).toContain('Compras/Ventas 37% / 63%');
    expect(msg).toContain('<i>No es asesoramiento financiero.</i>');
    expect(msg).toContain('Holders 1.024.516');
  });

  it('produces a valid Discord embed', () => {
    const body = JSON.parse(formatDiscord(article({ headline: 'Click [here](https://evil.example) **now** @everyone' }), `${BASE_URL}/#/live?article=art-1`));
    const embed = body.embeds[0];
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(embed.title).toBe('BREAKING — $Bonk · Solana');
    expect(embed.color).toBe(0x22c55e);
    expect(embed.url).toBe(`${BASE_URL}/#/live?article=art-1`);
    expect(embed.description).toContain('\\[here\\]\\(https://evil.example\\) \\*\\*now\\*\\*');
    expect(embed.fields.map((f: { name: string }) => f.name)).toEqual(['MC', 'Vol 1h', 'Tx/min', 'Buy/Sell', 'Holders', 'Quant']);
    expect(embed.fields[0].value).toBe('$331M');
    expect(embed.fields[5].value).toBe('Time-series momentum · 72%');
    expect(embed.footer.text).toBe('HootRadar · not financial advice');
    expect(embed.timestamp).toBe('2026-10-01T21:11:00.000Z');
    expect(embed.thumbnail.url).toMatch(/^https:\/\/cdn\.dexscreener\.com/);

    const alert = JSON.parse(formatDiscord(article({ severity: 'ALERT' }), null)).embeds[0];
    expect(alert.color).toBe(0x06b6d4);
  });

  it('shows unknown Discord figures as a dash, never as zero', () => {
    const unknown: CardMetrics = { ...cardMetrics(bonk()), marketCapUsd: null, volumeUsd: null, volumeWindow: null, txPerMin: null, buyPct: null, sellPct: null, holders: null };
    const embed = JSON.parse(formatDiscord(article({ metrics: unknown, quant: { ...article().quant, top: null } }), null)).embeds[0];
    expect(embed.fields.map((f: { value: string }) => f.value)).toEqual(['—', '—', '—', '—', '—', '—']);
    expect(embed.fields[1].name).toBe('Vol');
  });

  it('serializes a compact webhook article', () => {
    const body = JSON.parse(formatWebhook(article(), `${BASE_URL}/#/live?article=art-1`));
    expect(body.event).toBe('article.published');
    expect(body.article).toMatchObject({ id: 'art-1', severity: 'BREAKING', symbol: 'Bonk', url: `${BASE_URL}/#/live?article=art-1` });
    expect(body.article.quant.top).toEqual({ methodologyId: 'tsmom', name: 'Time-series momentum', score: 72.4 });
    expect(body.article).not.toHaveProperty('signals');
  });
});

/* ───────────── queue ───────────── */

const SECRETS = {
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/discordSecretToken',
  TELEGRAM_BOT_TOKEN: '123456:ABC-telegramSecret',
  TELEGRAM_CHAT_ID: '@hootradar',
  DISTRIBUTION_WEBHOOK_URL: 'https://hooks.example.com/in?key=hookSecret',
};

/** In-memory stand-in for the distribution part of Db. */
class FakeDb {
  readonly items = new Map<string, DistributionItem>();
  insertDistribution(d: DistributionItem): void {
    this.items.set(d.id, { ...d });
  }
  updateDistribution(id: string, patch: Partial<Pick<DistributionItem, 'status' | 'sentAt' | 'error'>>): void {
    const current = this.items.get(id);
    if (current) this.items.set(id, { ...current, ...patch });
  }
  pendingDistribution(limit: number): DistributionItem[] {
    return [...this.items.values()].filter((i) => i.status === 'queued').slice(0, limit);
  }
  counts(sinceTs: number) {
    const distributed = [...this.items.values()].filter((i) => i.status === 'sent' && (i.sentAt ?? 0) >= sinceTs).length;
    return { tokensAnalyzed: 0, anomalies: 0, breaking: 0, articles: 0, distributed, perChainTokens: {} };
  }
  byChannel(channel: string): DistributionItem {
    const item = [...this.items.values()].find((i) => i.channel === channel);
    if (!item) throw new Error(`no ${channel} item`);
    return item;
  }
}

interface Harness {
  db: FakeDb;
  queue: DistributionQueue;
  fetch: ReturnType<typeof vi.fn>;
  clock: { now: number };
}

function harness(env: Record<string, string>, respond: (url: string) => Response | Promise<Response>): Harness {
  const db = new FakeDb();
  const clock = { now: T0 };
  const fetch = vi.fn(async (url: string | URL | Request) => respond(String(url)));
  const config: AppConfig = loadConfig({ PUBLIC_BASE_URL: BASE_URL, ...env });
  const queue = new DistributionQueue({ db: db as unknown as Db, config, fetch: fetch as unknown as typeof globalThis.fetch, now: () => clock.now });
  return { db, queue, fetch, clock };
}

const ok = (url: string) =>
  url.includes('api.telegram.org') ? new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }) : new Response(null, { status: 204 });

const callsTo = (h: Harness, host: string) => h.fetch.mock.calls.filter(([url]) => String(url).includes(host)).length;

describe('DistributionQueue', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    const capture = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('queues configured channels at or above the minimum severity; X is always ready', () => {
    const h = harness({ ...SECRETS, DISTRIBUTION_MIN_SEVERITY: 'ALERT' }, ok);
    const items = h.queue.enqueue(article({ severity: 'ALERT' }));
    expect(Object.fromEntries(items.map((i) => [i.channel, i.status]))).toEqual({
      x: 'ready',
      telegram: 'queued',
      discord: 'queued',
      webhook: 'queued',
    });
    expect(h.db.items.size).toBe(4);
    expect(items.every((i) => i.articleId === 'art-1' && i.createdAt === T0 && i.sentAt === null)).toBe(true);
    expect(h.queue.enabledChannels()).toEqual(['telegram', 'discord', 'webhook']);
  });

  it('leaves items ready below the minimum severity or without configuration', () => {
    const below = harness(SECRETS, ok); // default minimum is BREAKING
    expect(below.queue.enqueue(article({ severity: 'ALERT' })).map((i) => i.status)).toEqual(['ready', 'ready', 'ready', 'ready']);

    const none = harness({}, ok);
    expect(none.queue.enqueue(article()).map((i) => i.status)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(none.queue.enabledChannels()).toEqual([]);

    const telegramWithoutChat = harness({ TELEGRAM_BOT_TOKEN: SECRETS.TELEGRAM_BOT_TOKEN }, ok);
    expect(telegramWithoutChat.queue.enqueue(article()).find((i) => i.channel === 'telegram')?.status).toBe('ready');
  });

  it('delivers queued items to Telegram, Discord and the webhook', async () => {
    const h = harness(SECRETS, ok);
    h.queue.enqueue(article());
    h.clock.now += 1000;
    await h.queue.flush();

    for (const channel of ['telegram', 'discord', 'webhook']) {
      expect(h.db.byChannel(channel)).toMatchObject({ status: 'sent', sentAt: T0 + 1000, error: null });
    }
    expect(h.db.byChannel('x').status).toBe('ready');
    expect(h.fetch).toHaveBeenCalledTimes(3);

    const telegram = h.fetch.mock.calls.find(([url]) => String(url).includes('telegram'))!;
    expect(telegram[0]).toBe(`https://api.telegram.org/bot${SECRETS.TELEGRAM_BOT_TOKEN}/sendMessage`);
    expect(telegram[1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(telegram[1].body)).toEqual({
      chat_id: '@hootradar',
      text: h.db.byChannel('telegram').payload,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    const discord = h.fetch.mock.calls.find(([url]) => url === SECRETS.DISCORD_WEBHOOK_URL)!;
    expect(discord[1].body).toBe(h.db.byChannel('discord').payload);
    const webhook = h.fetch.mock.calls.find(([url]) => url === SECRETS.DISTRIBUTION_WEBHOOK_URL)!;
    expect(JSON.parse(webhook[1].body).article.id).toBe('art-1');

    expect(h.queue.sentSince(T0)).toBe(3);
    await h.queue.flush();
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries with exponential backoff and fails after three attempts', async () => {
    const h = harness({ DISCORD_WEBHOOK_URL: SECRETS.DISCORD_WEBHOOK_URL }, () => new Response('upstream down', { status: 502 }));
    h.queue.enqueue(article());

    await h.queue.flush();
    expect(h.db.byChannel('discord')).toMatchObject({ status: 'queued', error: 'HTTP 502: upstream down' });

    h.clock.now += 4_999; // first backoff is 5 s
    await h.queue.flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);

    h.clock.now += 1;
    await h.queue.flush();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.db.byChannel('discord').status).toBe('queued');

    h.clock.now += 9_999; // second backoff is 10 s
    await h.queue.flush();
    expect(h.fetch).toHaveBeenCalledTimes(2);

    h.clock.now += 1;
    await h.queue.flush();
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(h.db.byChannel('discord')).toMatchObject({ status: 'failed', sentAt: null, error: 'HTTP 502: upstream down' });

    h.clock.now += 60_000;
    await h.queue.flush();
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it('fails permanent client errors immediately', async () => {
    const h = harness({ DISCORD_WEBHOOK_URL: SECRETS.DISCORD_WEBHOOK_URL }, () => new Response('{"message":"Unknown Webhook"}', { status: 404 }));
    h.queue.enqueue(article());
    await h.queue.flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.db.byChannel('discord')).toMatchObject({ status: 'failed', error: 'HTTP 404: {"message":"Unknown Webhook"}' });
  });

  it('honours Retry-After on rate limits', async () => {
    let calls = 0;
    const h = harness(
      { TELEGRAM_BOT_TOKEN: SECRETS.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: SECRETS.TELEGRAM_CHAT_ID },
      (url) => (++calls === 1 ? new Response('{"ok":false}', { status: 429, headers: { 'retry-after': '30' } }) : ok(url)),
    );
    h.queue.enqueue(article());
    await h.queue.flush();
    h.clock.now += 10_000;
    await h.queue.flush();
    expect(calls).toBe(1);
    h.clock.now += 20_000;
    await h.queue.flush();
    expect(calls).toBe(2);
    expect(h.db.byChannel('telegram').status).toBe('sent');
  });

  it('never stores or logs bot tokens or webhook secrets', async () => {
    const h = harness(SECRETS, (url) => {
      if (url.includes('telegram')) throw new TypeError(`fetch failed for ${url}`);
      if (url.includes('discord')) return new Response(`invalid token in ${url}`, { status: 401 });
      return new Response(`bad key ${SECRETS.DISTRIBUTION_WEBHOOK_URL}`, { status: 403 });
    });
    h.queue.enqueue(article());
    for (let i = 0; i < 3; i++) {
      await h.queue.flush();
      h.clock.now += 60_000;
    }
    const errors = [...h.db.items.values()].map((i) => i.error ?? '').join('\n');
    expect(errors).toContain('[redacted]');
    for (const text of [errors, logs.join('\n')]) {
      expect(text).not.toContain('telegramSecret');
      expect(text).not.toContain('discordSecretToken');
      expect(text).not.toContain('hookSecret');
    }
    expect(h.db.byChannel('telegram').status).toBe('failed');
  });

  it('treats a Telegram ok:false answer as a failure', async () => {
    const h = harness(
      { TELEGRAM_BOT_TOKEN: SECRETS.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: SECRETS.TELEGRAM_CHAT_ID },
      () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 200 }),
    );
    h.queue.enqueue(article());
    await h.queue.flush();
    expect(h.db.byChannel('telegram')).toMatchObject({ status: 'failed', error: 'Telegram: Bad Request: chat not found' });
  });

  it('releases items whose channel is no longer configured', async () => {
    const before = harness(SECRETS, ok);
    before.queue.enqueue(article());
    const after = new DistributionQueue({
      db: before.db as unknown as Db,
      config: loadConfig({}),
      fetch: before.fetch as unknown as typeof globalThis.fetch,
      now: () => T0,
    });
    await after.flush();
    expect(before.fetch).not.toHaveBeenCalled();
    expect(before.db.byChannel('discord')).toMatchObject({ status: 'ready', error: 'channel not configured' });
  });

  it('runs the worker every 3 seconds between start and stop', async () => {
    vi.useFakeTimers();
    const h = harness({ DISCORD_WEBHOOK_URL: SECRETS.DISCORD_WEBHOOK_URL }, ok);
    h.queue.start();
    h.queue.enqueue(article());
    await vi.advanceTimersByTimeAsync(2_999);
    expect(callsTo(h, 'discord')).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(callsTo(h, 'discord')).toBe(1);
    h.queue.stop();
    h.queue.enqueue(article({ id: 'art-2' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callsTo(h, 'discord')).toBe(1);
  });
});
