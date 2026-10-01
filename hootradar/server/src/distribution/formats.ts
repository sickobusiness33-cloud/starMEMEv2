import type { DistributionChannel, NewsArticle, Severity, TimeWindow } from '../../../shared/types.js';
import { DASH, fmtNum, fmtRate, fmtShare, fmtUsd, isNum, type Lang } from '../ai/format.js';
import { chainName, clampText, displaySymbol, methodologyLabel } from '../ai/rules-writer.js';

/**
 * Channel-ready renderings of one article. Articles carry no emojis; a single
 * severity emoji opens the X and Telegram posts. Token names and symbols are
 * provider data, so every format escapes them for its own markup.
 */

export interface ChannelPayload {
  channel: DistributionChannel;
  payload: string;
}

export function formatForChannels(a: NewsArticle, publicBaseUrl: string | null): ChannelPayload[] {
  const link = articleUrl(a, publicBaseUrl);
  return [
    { channel: 'x', payload: formatX(a, link) },
    { channel: 'telegram', payload: formatTelegram(a, link) },
    { channel: 'discord', payload: formatDiscord(a, link) },
    { channel: 'webhook', payload: formatWebhook(a, link) },
  ];
}

/** Public deep link to the article in the web app, or null when no public URL is configured. */
export function articleUrl(a: Pick<NewsArticle, 'id'>, publicBaseUrl: string | null): string | null {
  if (!publicBaseUrl || !isHttpUrl(publicBaseUrl)) return null;
  return `${publicBaseUrl.replace(/\/+$/, '')}/#/live?article=${encodeURIComponent(a.id)}`;
}

const SEVERITY_EMOJI: Record<Severity, string> = { BREAKING: '🚨', ALERT: '⚡', WATCH: '👀' };
/** Discord embed colors: green for BREAKING, cyan for ALERT, slate for WATCH. */
const SEVERITY_COLOR: Record<Severity, number> = { BREAKING: 0x22c55e, ALERT: 0x06b6d4, WATCH: 0x94a3b8 };
const WINDOW_SHORT: Record<TimeWindow, string> = { m5: '5m', m15: '15m', m30: '30m', h1: '1h', h6: '6h', h24: '24h' };

interface Labels {
  liquidity: string;
  buySell: string;
  read: string;
  explorer: string;
  disclaimer: string;
  footer: string;
}

const LABELS: Record<Lang, Labels> = {
  es: {
    liquidity: 'Liquidez',
    buySell: 'Compras/Ventas',
    read: 'Leer en HootRadar',
    explorer: 'Explorador',
    disclaimer: 'No es asesoramiento financiero.',
    footer: 'HootRadar · no es asesoramiento financiero',
  },
  en: {
    liquidity: 'Liquidity',
    buySell: 'Buy/Sell',
    read: 'Read on HootRadar',
    explorer: 'Explorer',
    disclaimer: 'Not financial advice.',
    footer: 'HootRadar · not financial advice',
  },
};

/* ───────────── shared figures ───────────── */

interface Figures {
  valuationLabel: 'MC' | 'FDV';
  valuation: string | null;
  liquidity: string | null;
  volumeLabel: string;
  volume: string | null;
  txPerMin: string | null;
  buySell: string | null;
  holders: string | null;
  quant: string | null;
}

function figures(a: NewsArticle): Figures {
  const m = a.metrics;
  const known = (n: number | null, fmt: (x: number) => string) => (isNum(n) ? fmt(n) : null);
  const top = a.quant.top;
  return {
    valuationLabel: m.mcIsFdv ? 'FDV' : 'MC',
    valuation: known(m.marketCapUsd, fmtUsd),
    liquidity: known(m.liquidityUsd, fmtUsd),
    volumeLabel: `Vol${m.volumeWindow ? ` ${WINDOW_SHORT[m.volumeWindow]}` : ''}`,
    volume: known(m.volumeUsd, fmtUsd),
    txPerMin: known(m.txPerMin, (x) => fmtRate(x, a.lang)),
    buySell:
      isNum(m.buyPct) && isNum(m.sellPct) ? `${fmtShare(m.buyPct, a.lang)} / ${fmtShare(m.sellPct, a.lang)}` : null,
    holders: known(m.holders, (x) => fmtNum(x, a.lang)),
    quant: top && top.score > 0 ? `${methodologyLabel(top.name)} · ${Math.round(top.score)}%` : null,
  };
}

/* ───────────── X ───────────── */

export const X_LIMIT = 280;
/** X wraps every link in t.co, which always counts as 23 characters. */
const X_URL_WEIGHT = 23;
const X_MIN_LEDE = 40;
const URL_PATTERN = /https?:\/\/\S+/g;

/** Plain-text post for manual copy-paste (never auto-posted), guaranteed to fit X's weighted 280-character limit. */
export function formatX(a: NewsArticle, link: string | null): string {
  const url = link ?? safeUrl(a.links.dexscreener);
  const header = `${SEVERITY_EMOJI[a.severity]} ${a.severity} — ${displaySymbol(a)} (${chainName(a.chain)})`;
  const f = figures(a);
  const stats = joinParts([
    f.valuation && `${f.valuationLabel} ${f.valuation}`,
    f.volume && `${f.volumeLabel} ${f.volume}`,
    f.txPerMin && `Tx/min ${f.txPerMin}`,
  ]);

  for (const statsLine of stats ? [stats, null] : [null]) {
    const fixed = [header, statsLine, url].filter((x): x is string => !!x);
    const budget = X_LIMIT - xLength(fixed.join('\n')) - 1; // newline before the lede
    if (budget < X_MIN_LEDE && statsLine) continue;
    const lede = fitX(a.lede, budget);
    const lines = [header, lede, statsLine, url].filter((x): x is string => !!x);
    const post = lines.join('\n');
    if (xLength(post) <= X_LIMIT) return post;
  }
  return fitX(header, X_LIMIT) ?? header;
}

/**
 * X's weighted length (twitter-text v3): most Latin, Greek, Cyrillic and common
 * punctuation count 1, everything else (CJK, emoji, "…") counts 2, URLs count 23.
 * Emoji sequences are counted per code point, which can only overestimate.
 */
export function xLength(text: string): number {
  const urls = text.match(URL_PATTERN) ?? [];
  const rest = text.replace(URL_PATTERN, '');
  let n = urls.length * X_URL_WEIGHT;
  for (const ch of rest) n += xWeight(ch.codePointAt(0)!);
  return n;
}

function xWeight(cp: number): number {
  const light =
    cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
  return light ? 1 : 2;
}

/** Whole sentences when they fit (at least X_MIN_LEDE worth), otherwise a word-boundary cut with an ellipsis. */
function fitX(text: string, budget: number): string | null {
  if (budget <= 1) return null;
  if (xLength(text) <= budget) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)/g) ?? [];
  let whole = '';
  for (const sentence of sentences) {
    if (xLength(whole + sentence) > budget) break;
    whole += sentence;
  }
  if (whole.trim() && xLength(whole.trim()) >= Math.min(X_MIN_LEDE, budget)) return whole.trim();
  let out = '';
  let used = 0;
  const room = budget - xWeight('…'.codePointAt(0)!);
  for (const ch of text.replace(URL_PATTERN, '')) {
    const w = xWeight(ch.codePointAt(0)!);
    if (used + w > room) break;
    out += ch;
    used += w;
  }
  const space = out.lastIndexOf(' ');
  if (space > out.length * 0.6) out = out.slice(0, space);
  out = out.replace(/[\s,;:.\-–—(]+$/, '');
  return out ? `${out}…` : null;
}

/* ───────────── Telegram ───────────── */

const TELEGRAM_LIMIT = 4096;

/** HTML parse-mode message. */
export function formatTelegram(a: NewsArticle, link: string | null): string {
  const full = telegramMessage(a, link, true);
  return full.length <= TELEGRAM_LIMIT ? full : telegramMessage(a, link, false);
}

function telegramMessage(a: NewsArticle, link: string | null, withBullets: boolean): string {
  const L = LABELS[a.lang];
  const f = figures(a);
  const lede = withBullets ? a.lede : clampText(a.lede, 1000);
  const statLines = [
    joinParts([
      f.valuation && `${f.valuationLabel} ${f.valuation}`,
      f.liquidity && `${L.liquidity} ${f.liquidity}`,
      f.volume && `${f.volumeLabel} ${f.volume}`,
    ]),
    joinParts([
      f.txPerMin && `Tx/min ${f.txPerMin}`,
      f.buySell && `${L.buySell} ${f.buySell}`,
      f.holders && `Holders ${f.holders}`,
    ]),
    f.quant ? `Quant: ${f.quant}` : null,
  ];
  const links = joinParts([
    link && anchor(link, L.read),
    safeUrl(a.links.dexscreener) && anchor(a.links.dexscreener!, 'DexScreener'),
    safeUrl(a.links.explorer) && anchor(a.links.explorer!, L.explorer),
  ]);

  const blocks: Array<Array<string | null>> = [
    [
      `${SEVERITY_EMOJI[a.severity]} <b>${escapeHtml(`${a.severity} — ${displaySymbol(a)}`)}</b> · ${escapeHtml(chainName(a.chain))}`,
      `<b>${escapeHtml(a.headline)}</b>`,
    ],
    [escapeHtml(lede)],
    [`<i>${escapeHtml(a.aiLine)}</i>`],
    withBullets ? a.whyItMatters.map((b) => `• ${escapeHtml(b)}`) : [],
    statLines.map((x) => (x ? escapeHtml(x) : null)),
    [links, `<i>${escapeHtml(L.disclaimer)}</i>`],
  ];
  return blocks
    .map((lines) => lines.filter((x): x is string => !!x).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

/** Telegram HTML mode: &, <, > in text and " inside attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function anchor(url: string, text: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

/* ───────────── Discord ───────────── */

/** Discord webhook body with one embed. Mentions are disabled because token names are untrusted. */
export function formatDiscord(a: NewsArticle, link: string | null): string {
  const L = LABELS[a.lang];
  const f = figures(a);
  const field = (name: string, value: string | null) => ({ name, value: value ? escapeMarkdown(value) : DASH, inline: true });
  const url = link ?? safeUrl(a.links.dexscreener);
  const thumbnail = safeUrl(a.imageUrl);
  const embed = {
    title: clampText(`${a.severity} — ${displaySymbol(a)} · ${chainName(a.chain)}`, 256),
    description: clip(
      [`**${escapeMarkdown(a.headline)}**`, escapeMarkdown(a.lede), `*${escapeMarkdown(a.aiLine)}*`].join('\n\n'),
      4096,
    ),
    ...(url ? { url } : {}),
    color: SEVERITY_COLOR[a.severity],
    fields: [
      field(f.valuationLabel, f.valuation),
      field(f.volumeLabel, f.volume),
      field('Tx/min', f.txPerMin),
      field('Buy/Sell', f.buySell),
      field('Holders', f.holders),
      field('Quant', f.quant),
    ],
    footer: { text: L.footer },
    timestamp: new Date(a.createdAt).toISOString(),
    ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
  };
  return JSON.stringify({ username: 'HootRadar', embeds: [embed], allowed_mentions: { parse: [] } });
}

/** Neutralizes Discord markdown (bold, masked links, code, spoilers) in provider-supplied text. */
export function escapeMarkdown(s: string): string {
  return s.replace(/([\\*_~`|>[\]()])/g, '\\$1');
}

/* ───────────── generic webhook ───────────── */

/** Compact JSON article for third-party integrations. */
export function formatWebhook(a: NewsArticle, link: string | null): string {
  const top = a.quant.top;
  return JSON.stringify({
    event: 'article.published',
    article: {
      id: a.id,
      url: link,
      createdAt: new Date(a.createdAt).toISOString(),
      severity: a.severity,
      score: a.score,
      chain: a.chain,
      address: a.address,
      symbol: a.symbol,
      name: a.name,
      headline: a.headline,
      lede: a.lede,
      aiLine: a.aiLine,
      whyItMatters: a.whyItMatters,
      quantAnalysis: a.quantAnalysis,
      outlook: a.outlook,
      metrics: a.metrics,
      quant: {
        top: top ? { methodologyId: top.methodologyId, name: top.name, score: top.score } : null,
        regime: a.quant.regime.label,
        riskFlags: a.quant.riskFlags,
      },
      links: a.links,
      engine: a.engine,
      model: a.model,
      lang: a.lang,
      updateOf: a.updateOf,
    },
  });
}

/* ───────────── helpers ───────────── */

/** Hard length cap that keeps line breaks (clampText normalizes whitespace). */
function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function joinParts(parts: Array<string | null | false | undefined>): string | null {
  const kept = parts.filter((x): x is string => !!x);
  return kept.length ? kept.join(' · ') : null;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function safeUrl(s: string | null | undefined): string | null {
  return s && isHttpUrl(s) ? s : null;
}
