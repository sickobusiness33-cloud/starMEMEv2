import { z } from 'zod';
import type {
  DerivedMetrics,
  Detection,
  NewsArticle,
  QuantResult,
  TimeWindow,
  TokenSnapshot,
  TxCounts,
} from '../../../shared/types.js';
import { logger } from '../log.js';
import {
  AiOutputError,
  CallLimiter,
  QueueFullError,
  aiErrorDetail,
  claudeSession,
  createStructured,
  jsonOutputFormat,
  reportAiError,
  reportAiOk,
} from './claude.js';
import {
  fmtAge,
  fmtDuration,
  fmtMult,
  fmtNum,
  fmtPct,
  fmtRate,
  fmtShare,
  fmtUsd,
  isNum,
  type Lang,
} from './format.js';
import {
  ARTICLE_LIMITS,
  chainName,
  displaySymbol,
  plainText,
  writeArticleRules,
  type CopyInput,
} from './rules-writer.js';

export interface NewsInput {
  snapshot: TokenSnapshot;
  metrics: DerivedMetrics;
  detection: Detection;
  quant: QuantResult;
  lang: 'es' | 'en';
  previous: NewsArticle | null;
}

export type ArticleDraft = Pick<
  NewsArticle,
  'headline' | 'lede' | 'aiLine' | 'whyItMatters' | 'quantAnalysis' | 'outlook' | 'engine' | 'model' | 'lang'
>;

const log = logger('newswriter');

/** Thinking is always on for the default model; this leaves ample room for it plus ~600 tokens of JSON. */
const MAX_TOKENS = 8000;
/** At most 2 calls in flight; a short queue absorbs small bursts, anything beyond is written by rules immediately. */
const limiter = new CallLimiter(2, 6);

const field = (max: number, description: string) => z.string().min(1).max(max).describe(description);

const ArticleSchema = z.object({
  headline: field(ARTICLE_LIMITS.headline, 'One factual line leading with the strongest signal and one key figure.'),
  lede: field(ARTICLE_LIMITS.lede, '1-2 sentences: what is happening, token, chain, age; then the most relevant figures.'),
  aiLine: field(ARTICLE_LIMITS.aiLine, 'One sober sentence with the single most important takeaway.'),
  whyItMatters: z
    .array(field(ARTICLE_LIMITS.bullet, 'One distinct reason grounded in a specific fact. No bullet symbol.'))
    .length(3)
    .describe('Exactly 3 bullets.'),
  quantAnalysis: field(ARTICLE_LIMITS.quantAnalysis, 'Which methodologies the conditions resemble, with match %. Never a forecast.'),
  outlook: z.object({
    bullish: field(ARTICLE_LIMITS.outlook, 'Conditional scenario in which activity could continue.'),
    neutral: field(ARTICLE_LIMITS.outlook, 'What consolidation would look like.'),
    risk: field(ARTICLE_LIMITS.outlook, 'Concrete risks present in the facts.'),
  }),
});
type ArticleJson = z.infer<typeof ArticleSchema>;

const ARTICLE_FORMAT = jsonOutputFormat(ArticleSchema);

/** Static (cached) instructions. Per-request data goes in the user turn only. */
export const NEWS_SYSTEM_PROMPT = `You are the wire editor of HootRadar, a real-time crypto intelligence newsroom. You turn verified on-chain facts about one token into a very short, professional news item in the style of a financial wire service.

Hard rules:
1. Use only the facts inside <facts>. Every figure you write (amounts, prices, percentages, multiples, counts, ages, scores) must appear in the facts, copied exactly as formatted there. Never compute, convert, estimate or round figures. Never add context the facts do not state (partnerships, listings, team, exchanges, news events).
2. When a fact is missing, leave it out. Never write "null", "N/A", "unknown" or placeholders.
3. No predictions. Never state or imply that the price will rise. Scenarios use conditional language ("could", "if ... then").
4. No financial advice and no calls to action (buy, sell, enter, don't miss).
5. No hype vocabulary: never "moon", "to the moon", "100x", "gem", "lambo", "rocket", "explosive", "insane", "guaranteed".
6. No emojis, no hashtags, no exclamation marks.
7. Refer to the token by facts.token.symbol exactly as given (e.g. $OWL).
8. Write in the language requested in the task. Keep figures exactly as formatted in the facts, including decimal commas in Spanish.
9. A similarity to a quant methodology is not a forecast; say so whenever you mention one.

Fields:
- headline: one line, at most 110 characters. Factual, leads with the strongest signal and one key figure. Do not include the severity label; the interface adds it.
- lede: 1-2 sentences, at most 320 characters. First sentence: what is happening, to which token, on which chain, and how old the token is when known. Second sentence: the two or three most relevant figures.
- aiLine: one sentence, at most 160 characters: the single most important takeaway.
- whyItMatters: exactly 3 items, each at most 140 characters, each a different reason grounded in a specific fact (order flow, participation, liquidity, holder concentration, market regime).
- quantAnalysis: 1-3 sentences, at most 500 characters. Name the methodologies in facts.quant.topMatches whose conditions the token currently resembles, with their match percentage, and state that this is similarity, not a forecast. If there are none, say no methodology in the library shows a relevant similarity.
- outlook.bullish: one sentence, at most 300 characters: the conditions under which activity could continue.
- outlook.neutral: one sentence, at most 300 characters: what a consolidation would look like.
- outlook.risk: 1-2 sentences, at most 300 characters, always concrete. Name the specific risks present in the facts: thin liquidity, holder concentration, mint or freeze authority enabled, developer holdings, paid promotion, volume far above liquidity (possible wash trading), sell pressure, a very young token (rug risk). If none is flagged, describe the concrete risk of a liquidity pull (rug) or a sharp reversal after an activity spike.

Young tokens: facts.token.windowsSinceLaunch lists the windows (1h, 6h, 24h) that are longer than the token's trading life. Every figure in those windows (volume, price change, transactions) covers its whole life: describe it as "since launch", never as "in the last hour" or "in 24 hours", and never as an hourly rate or average. When facts.token.windowsCoverWholeLife is "yes" this applies to every window.

Follow-ups: when facts.previousArticle is present, this item updates it. Say what changed (escalation, new figures) without repeating the earlier item.

Style reference in Spanish. It only shows tone and structure; N and $X are placeholders, never figures to reuse:
headline: "Aceleración on-chain en $TOKEN: volumen Nx sobre la media de 1 h"
lede: "$TOKEN, lanzado hace N minutos en Solana, está registrando una fuerte aceleración de actividad on-chain. El volumen ha alcanzado $X y las transacciones se han multiplicado por N frente a la media de la última hora."
aiLine: "El token está mostrando una aceleración anormal de actividad on-chain durante los últimos minutos."`;

/** Writes the article with Claude when configured; any failure falls back to the rules writer. Never throws. */
export async function writeArticle(i: NewsInput): Promise<ArticleDraft> {
  const session = claudeSession();
  if (!session) return writeArticleRules(i);

  try {
    const facts = JSON.stringify(articleFacts(i));
    const json = await limiter.run(() =>
      createStructured(session, {
        system: NEWS_SYSTEM_PROMPT,
        user: newsPrompt(i, facts),
        format: ARTICLE_FORMAT,
        schema: ArticleSchema,
        effort: session.ai.effortNews,
        maxTokens: MAX_TOKENS,
      }),
    );
    const draft = normalizeArticle(json);
    assertPublishable(copyTexts(draft), facts);
    reportAiOk();
    return { ...draft, engine: 'claude', model: session.ai.model, lang: i.lang };
  } catch (e) {
    return fallback(i, e);
  }
}

function fallback(i: NewsInput, e: unknown): ArticleDraft {
  if (e instanceof QueueFullError) {
    log.info('Claude queue full, article written by rules', { symbol: i.snapshot.symbol });
  } else {
    reportAiError(e);
    log.warn('Claude article failed, written by rules', { symbol: i.snapshot.symbol, error: aiErrorDetail(e) });
  }
  return writeArticleRules(i);
}

function newsPrompt(i: NewsInput, facts: string): string {
  const language = i.lang === 'es' ? 'Spanish' : 'English';
  const severity = i.detection.severity ?? 'ALERT';
  return [
    `Write a ${severity} news item in ${language} about the token described below.`,
    i.previous ? 'It is a follow-up to facts.previousArticle.' : null,
    '<facts>',
    facts,
    '</facts>',
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeArticle(a: ArticleJson): Omit<ArticleDraft, 'engine' | 'model' | 'lang'> {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  return {
    headline: clean(a.headline),
    lede: clean(a.lede),
    aiLine: clean(a.aiLine),
    whyItMatters: a.whyItMatters.map((b) => clean(b.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, ''))),
    quantAnalysis: clean(a.quantAnalysis),
    outlook: { bullish: clean(a.outlook.bullish), neutral: clean(a.outlook.neutral), risk: clean(a.outlook.risk) },
  };
}

function copyTexts(d: Omit<ArticleDraft, 'engine' | 'model' | 'lang'>): string[] {
  return [d.headline, d.lede, d.aiLine, ...d.whyItMatters, d.quantAnalysis, d.outlook.bullish, d.outlook.neutral, d.outlook.risk];
}

/* ───────────── output guards ───────────── */

/** Word boundaries that understand accented letters ("subirá" ends in a letter \b does not know). */
const wordRe = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, 'iu');
/** The forbidden vocabulary of the system prompt, in both languages. */
const HYPE = wordRe(
  'moon(?:ing|s)?|to the moon|lambo|gems?|rocket(?:s|ing|ed)?|explosive|insane|guaranteed?|a la luna|cohetes?|explosiv[oa]s?|garantizad[oa]s?|garantía',
);
/** Certainty about a future price (no predictions): "will rise", "va a subir", "subirá", "garantiza". */
const PREDICTION = wordRe(
  [
    '(?:will|is going to|are going to|is set to|is poised to|is bound to)\\s+(?:rise|rally|pump|soar|surge|climb|explode|skyrocket|go up|moon|double|triple)',
    'subirán?|se disparar(?:á|án)|despegará|explotará|duplicará|triplicará',
    'van? a (?:subir|dispararse|despegar|explotar|duplicar|triplicar)',
    'garantiz\\p{L}*',
  ].join('|'),
);
const EMOJI = /\p{Extended_Pictographic}/u;
const FIGURE = /\d+(?:[.,]\d+)*/g;
/** "4.2x", "100x", "10 x": a multiple, compared with the multiples the facts state */
const MULTIPLE = /(\d+(?:[.,]\d+)*)\s?x(?![\p{L}\p{N}])/giu;
/** "72/100" is a score on a 100 scale: its "100" is not a figure the copy may reuse ("100%", "100x") */
const SCALE = /\/\s?100(?![\d.,])/g;
/** Small counts and time units read naturally in prose ("3 escenarios", "24 horas") without being invented data. */
const FREE_FIGURES = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '24', '60']);

/**
 * Rejects copy that breaks the newsroom rules: hype words, predictions, emojis, a
 * multiple ("100x") the facts do not state, or a figure that does not occur in the
 * facts (compared on digits, so "$1.4M" and "$1,4M" match).
 */
export function assertPublishable(texts: string[], factsJson: string): void {
  for (const t of texts) {
    if (EMOJI.test(t)) throw new AiOutputError('emoji in copy');
    const hype = HYPE.exec(t);
    if (hype) throw new AiOutputError(`hype word "${hype[0]}"`);
    const prediction = PREDICTION.exec(t);
    if (prediction) throw new AiOutputError(`prediction "${prediction[0]}"`);
  }
  const text = texts.join(' ');
  const multiples = unsupportedMultiples(text, factsJson);
  if (multiples.length) throw new AiOutputError(`hype multiple not in facts: ${multiples.slice(0, 3).join(', ')}`);
  const unknown = unsupportedFigures(text, factsJson);
  if (unknown.length) throw new AiOutputError(`figure not in facts: ${unknown.slice(0, 3).join(', ')}`);
}

export function unsupportedFigures(text: string, factsJson: string): string[] {
  const allowed = new Set([...factsJson.replace(SCALE, '').matchAll(FIGURE)].map((m) => digitsOf(m[0])));
  return [...text.replace(SCALE, '').matchAll(FIGURE)]
    .map((m) => m[0])
    .filter((f) => {
      const d = digitsOf(f);
      return !allowed.has(d) && !FREE_FIGURES.has(d);
    });
}

/** Multiples in the copy ("100x", "10x") that the facts never state as a multiple. */
export function unsupportedMultiples(text: string, factsJson: string): string[] {
  const allowed = new Set([...factsJson.matchAll(MULTIPLE)].map((m) => digitsOf(m[1] ?? '')));
  return [...text.matchAll(MULTIPLE)].filter((m) => !allowed.has(digitsOf(m[1] ?? ''))).map((m) => m[0]);
}

function digitsOf(figure: string): string {
  return figure.replace(/[.,]/g, '').replace(/^0+(?=\d)/, '');
}

/* ───────────── facts ───────────── */

type FactValue = string | number | boolean | FactValue[] | { [k: string]: FactValue | undefined } | null | undefined;

/** Windows that cover a token's whole life while it is younger than their length. */
const LIFE_WINDOWS: Array<[string, number]> = [
  ['1h', 60],
  ['6h', 360],
  ['24h', 1440],
];

const WINDOWS: Array<[TimeWindow, string]> = [
  ['m5', '5m'],
  ['h1', '1h'],
  ['h6', '6h'],
  ['h24', '24h'],
];

/**
 * Compact facts for the model: only known values, numbers pre-formatted in the
 * target language so the model can copy them verbatim.
 */
export function tokenFacts(i: CopyInput): Record<string, unknown> {
  const { snapshot: s, metrics: m, detection: d, quant: q, lang } = i;
  const f = factFormatters(lang);
  const fdvOnly = !isNum(s.marketCapUsd) && isNum(s.fdvUsd);
  // the windows were measured on one pool: under an hour of its life the 1 h window is its whole
  // life, so 5m-vs-1h ratios compare with its launch average
  const windowAge = m.windowAgeMinutes ?? m.ageMinutes;
  const sinceLaunch = isNum(windowAge) && windowAge <= 60;
  const vs = sinceLaunch ? 'VsAverageSinceLaunch' : 'Vs1hAverage';
  const wholeLife = isNum(windowAge) ? LIFE_WINDOWS.filter(([, minutes]) => windowAge < minutes).map(([label]) => label) : [];
  return prune({
    token: {
      symbol: displaySymbol(s),
      name: plainText(s.name, 60) || undefined,
      chain: chainName(s.chain),
      dex: s.dex ?? undefined,
      launched: f.age(m.ageMinutes),
      windowsCoverWholeLife: sinceLaunch ? 'yes' : undefined,
      windowsSinceLaunch: wholeLife.length ? wholeLife : undefined,
      paidPromotion: s.boosted ? 'yes (DexScreener boost)' : undefined,
    },
    detection: {
      severity: d.severity ?? undefined,
      anomalyScore: `${d.score}/100`,
      signals: [...d.signals].sort((a, b) => b.weight - a.weight).slice(0, 6).map((x) => x.label),
    },
    market: {
      price: f.usd(s.priceUsd),
      marketCap: f.usd(s.marketCapUsd),
      fdv: fdvOnly ? f.usd(s.fdvUsd) : undefined,
      liquidity: f.usd(s.liquidityUsd),
      volume: windows((w) => f.usd(s.volumeUsd[w])),
      priceChange: windows((w) => f.pct(s.priceChangePct[w])),
      transactions: windows((w) => txFact(s.txns[w], lang)),
      transactionsPerMinute: f.rate(m.txPerMin),
      buyShare: m.buySellWindow ? withWindow(f.share(m.buyPct), m.buySellWindow) : undefined,
      uniqueBuyers5m: f.num(m.uniqueBuyersM5),
      averageTrade1h: f.usd(m.avgTradeUsd),
      volumeToLiquidity: f.mult(m.volumeToLiquidity),
    },
    acceleration: {
      [`volume5m${vs}`]: f.mult(m.volumeAcceleration),
      [`transactions5m${vs}`]: f.mult(m.txAcceleration),
      [`uniqueBuyers5m${vs}`]: f.mult(m.buyerAcceleration),
      momentumScore: isNum(m.momentumScore) ? `${Math.round(m.momentumScore)}/100` : undefined,
    },
    holders: {
      count: f.num(s.holders),
      growth: f.pct(m.holdersGrowthPct),
      growthWindow: isNum(m.holdersGrowthPct) ? f.dur(m.holdersGrowthWindowMin) : undefined,
      top10Share: f.share(s.top10HolderPct),
    },
    security: s.security
      ? {
          mintAuthority: flag(s.security.mintAuthority),
          freezeAuthority: flag(s.security.freezeAuthority),
          honeypot: s.security.honeypot,
          developerHolding: f.share(s.security.devHoldingPct),
        }
      : undefined,
    quant: {
      regime: q.regime.label !== 'unknown' ? q.regime.label : undefined,
      youngTokensUp1h: f.share(q.regime.breadthPct),
      topMatches: [...q.matches]
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((x) => ({ methodology: x.name, family: x.family, match: `${Math.round(x.score)}%`, rationale: x.rationale })),
    },
    riskFlags: q.riskFlags,
  }) as Record<string, unknown>;
}

function articleFacts(i: NewsInput): Record<string, unknown> {
  const facts = tokenFacts(i);
  const p = i.previous;
  if (!p) return facts;
  const minutes = (i.snapshot.ts - p.createdAt) / 60_000;
  return {
    ...facts,
    previousArticle: prune({
      headline: p.headline,
      severity: p.severity,
      anomalyScore: `${p.score}/100`,
      published: isNum(minutes) && minutes >= 0 ? fmtAge(minutes, i.lang) : undefined,
    }),
  };
}

function factFormatters(lang: Lang) {
  const known =
    (fn: (n: number) => string) =>
    (n: number | null | undefined): string | undefined =>
      isNum(n) ? fn(n) : undefined;
  return {
    usd: known(fmtUsd),
    pct: known((n) => fmtPct(n, undefined, lang)),
    share: known((n) => fmtShare(n, lang)),
    mult: known((n) => fmtMult(n, lang)),
    num: known((n) => fmtNum(n, lang)),
    rate: known((n) => fmtRate(n, lang)),
    age: known((n) => fmtAge(n, lang)),
    dur: known(fmtDuration),
  };
}

function windows(value: (w: TimeWindow) => FactValue): Record<string, FactValue> {
  return Object.fromEntries(WINDOWS.map(([w, label]) => [label, value(w)]));
}

function withWindow(value: string | undefined, w: TimeWindow): string | undefined {
  const label = WINDOWS.find(([x]) => x === w)?.[1] ?? w;
  return value ? `${value} (${label})` : undefined;
}

function txFact(t: TxCounts | undefined, lang: Lang): string | undefined {
  if (!t || !isNum(t.buys) || !isNum(t.sells)) return undefined;
  return `${fmtNum(t.buys, lang)} buys / ${fmtNum(t.sells, lang)} sells`;
}

function flag(v: boolean | null): string | undefined {
  return v === null ? undefined : v ? 'enabled' : 'disabled';
}

/** Drops null/undefined values and the empty objects/arrays they leave behind. */
function prune(v: FactValue): FactValue {
  if (Array.isArray(v)) {
    const items = v.map(prune).filter((x) => x !== undefined);
    return items.length ? items : undefined;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v)
      .map(([k, x]) => [k, prune(x)] as const)
      .filter(([, x]) => x !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return v === null || v === undefined || v === '' ? undefined : v;
}
