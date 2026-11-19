import type {
  AnomalySignal,
  ChainId,
  DerivedMetrics,
  Detection,
  NewsOutlook,
  QuantResult,
  Severity,
  SignalCode,
  TimeWindow,
  TokenSnapshot,
} from '../../../shared/types.js';
import { CHAIN_CONFIGS } from '../chains/configs.js';
import type { ChainConfig } from '../chains/types.js';
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
import { volumeToLiquidityWindow } from '../engine/metrics.js';
import type { ArticleDraft, NewsInput } from './newswriter.js';

/**
 * Deterministic wire-style copy. Every figure comes from the input; a clause
 * whose data is missing is left out rather than filled. Wording variants are
 * picked from a hash of the token address, so a token always reads the same
 * while different tokens do not all sound alike.
 */

/** Maximum lengths shared with the Claude writer's validation. */
export const ARTICLE_LIMITS = {
  headline: 110,
  lede: 320,
  aiLine: 160,
  bullet: 140,
  quantAnalysis: 500,
  outlook: 300,
} as const;

/** What the copy helpers need; the Radar brief uses them without a previous article. */
export interface CopyInput {
  snapshot: TokenSnapshot;
  metrics: DerivedMetrics;
  detection: Detection;
  quant: QuantResult;
  lang: Lang;
}

export function writeArticleRules(i: NewsInput): ArticleDraft {
  const c = context(i);
  const lead = leadCopy(c);
  return {
    headline: headline(c, lead),
    lede: lede(c, lead, i.previous),
    aiLine: clampText(pick(lead.copy.aiLines, c.seed, 'ai'), ARTICLE_LIMITS.aiLine),
    whyItMatters: rulesInsights(i, 3),
    quantAnalysis: rulesQuantAnalysis(i),
    outlook: rulesOutlook(i),
    engine: 'rules',
    model: null,
    lang: i.lang,
  };
}

/** Exactly `count` short "why it matters" bullets: secondary signals, then market context, then always-true facts. */
export function rulesInsights(i: CopyInput, count: number): string[] {
  const c = context(i);
  const p = PACKS[c.lang];
  const ranked = signalCopies(c);
  // The lead signal already carries the headline and lede, so secondary signals explain first.
  const signalBullets = [...ranked.slice(1), ...ranked.slice(0, 1)].map((x) => x.copy.bullet);
  const contextBullets = p.contextBullets(c);
  const chosen = [
    ...signalBullets.slice(0, Math.max(1, count - 1)),
    ...contextBullets.slice(0, 1),
    ...signalBullets.slice(Math.max(1, count - 1)),
    ...contextBullets.slice(1),
    ...p.fillerBullets(c),
  ];
  return unique(chosen)
    .slice(0, count)
    .map((b) => clampText(b, ARTICLE_LIMITS.bullet));
}

export function rulesQuantAnalysis(i: CopyInput): string {
  const c = context(i);
  const matches = [...i.quant.matches]
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => ({ name: methodologyLabel(x.name), score: `${Math.round(x.score)}%` }));
  return clampText(PACKS[c.lang].quant(c, matches), ARTICLE_LIMITS.quantAnalysis);
}

export function rulesOutlook(i: CopyInput): NewsOutlook {
  const c = context(i);
  const p = PACKS[c.lang];
  const lead = leadCopy(c);
  // a token below every alert threshold with no flow or launch signal (Radar on a quiet token)
  // has no move to extend or digest
  const family: Family = isQuiet(c) ? 'quiet' : familyOf(lead.code);
  const baseline = (text: string) => (sinceLaunch(c.m) ? swapBaseline(text, c.lang) : text);
  return {
    bullish: clampText(baseline(p.bullish(c, family)), ARTICLE_LIMITS.outlook),
    neutral: clampText(baseline(p.neutral(c, family)), ARTICLE_LIMITS.outlook),
    risk: clampText(p.risk(c, riskConcerns(c)), ARTICLE_LIMITS.outlook),
  };
}

/** Short noun phrase for the strongest signal ("un aumento notable de volumen"), or null without signals. */
export function rulesLeadPhrase(i: CopyInput): string | null {
  const c = context(i);
  const lead = leadCopy(c);
  return lead.code === 'generic' ? null : PACKS[c.lang].leadPhrase[lead.code][1];
}

/** "$OWL": emoji/control characters stripped, capped length, falls back to name or short address. */
export function displaySymbol(s: Pick<TokenSnapshot, 'symbol' | 'name' | 'address'>): string {
  const label = plainText(s.symbol.replace(/^\$+/, ''), 20) || plainText(s.name, 20) || shortAddress(s.address);
  return `$${label}`;
}

/** Methodology name without its explanatory parenthetical: "Volume breakout (high-volume return premium)" → "Volume breakout". */
export function methodologyLabel(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name;
}

export function chainName(chain: ChainId): string {
  const known = (CHAIN_CONFIGS as Record<string, ChainConfig | undefined>)[chain];
  return known?.name ?? capitalize(chain);
}

/** Cuts at a word boundary and adds an ellipsis when `s` is longer than `max` characters. */
export function clampText(s: string, max: number): string {
  const text = s.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.6) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:.\-–—(]+$/, '')}…`;
}

/* ───────────── context ───────────── */

/** Formatters that return null for unknown values, so templates can omit the clause. */
interface Fmt {
  usd(n: number | null | undefined): string | null;
  pct(n: number | null | undefined): string | null;
  share(n: number | null | undefined): string | null;
  mult(n: number | null | undefined): string | null;
  /** unsigned size of a change, for sentences whose verb carries the direction: "31%" */
  abs(n: number | null | undefined): string | null;
  /** multiple without the "x": "3,1" */
  times(n: number | null | undefined): string | null;
  num(n: number | null | undefined): string | null;
  rate(n: number | null | undefined): string | null;
  age(minutes: number | null | undefined): string | null;
  dur(minutes: number | null | undefined): string | null;
}

interface Ctx {
  s: TokenSnapshot;
  m: DerivedMetrics;
  d: Detection;
  q: QuantResult;
  lang: Lang;
  sym: string;
  chain: string;
  dex: string | null;
  seed: string;
  strong: boolean;
  f: Fmt;
}

function context(i: CopyInput): Ctx {
  return {
    s: i.snapshot,
    m: i.metrics,
    d: i.detection,
    q: i.quant,
    lang: i.lang,
    sym: displaySymbol(i.snapshot),
    chain: chainName(i.snapshot.chain),
    dex: i.snapshot.dex ? prettyDex(i.snapshot.dex) : null,
    seed: i.snapshot.address,
    strong: i.detection.severity === 'BREAKING',
    f: formatters(i.lang),
  };
}

function formatters(lang: Lang): Fmt {
  const known =
    (fn: (n: number) => string) =>
    (n: number | null | undefined): string | null =>
      isNum(n) ? fn(n) : null;
  return {
    usd: known(fmtUsd),
    pct: known((n) => fmtPct(n, undefined, lang)),
    share: known((n) => fmtShare(n, lang)),
    mult: known((n) => fmtMult(n, lang)),
    abs: known((n) => fmtShare(Math.abs(n), lang)),
    times: known((n) => fmtMult(n, lang).slice(0, -1)),
    num: known((n) => fmtNum(n, lang)),
    rate: known((n) => fmtRate(n, lang)),
    age: known((n) => fmtAge(n, lang)),
    dur: known(fmtDuration),
  };
}

/* ───────────── signal copy ───────────── */

interface SignalCopy {
  headlines: string[];
  aiLines: string[];
  bullet: string;
}

type CopyFn = (c: Ctx, sig: AnomalySignal) => SignalCopy | null;

interface RankedCopy {
  code: SignalCode | 'generic';
  copy: SignalCopy;
}

/** Copy for every signal that has the data it needs, strongest first. */
function signalCopies(c: Ctx): RankedCopy[] {
  const table = PACKS[c.lang].signals;
  return [...c.d.signals]
    .sort((a, b) => b.weight - a.weight)
    .flatMap((sig) => {
      const copy = table[sig.code](c, sig);
      if (!copy) return [];
      return [{ code: sig.code, copy: RATIO_SIGNALS.has(sig.code) && sinceLaunch(c.m) ? launchBaseline(copy, c.lang) : copy }];
    });
}

/** Signals measured as "last 5 minutes vs the 1 h average". */
const RATIO_SIGNALS: ReadonlySet<SignalCode> = new Set(['volume_surge', 'tx_acceleration', 'buyer_surge']);

/**
 * Under an hour old, a token's "1 h average" is its average since launch; say so
 * instead of implying an hour of history it does not have.
 */
const LAUNCH_BASELINE: Record<Lang, Array<[string, string]>> = {
  es: [
    ['el ritmo medio de la última hora', 'su ritmo medio desde el lanzamiento'],
    ['la media de la última hora', 'su media desde el lanzamiento'],
    ['el ritmo de la última hora', 'su ritmo desde el lanzamiento'],
    ['la media de 1 h', 'su media desde el lanzamiento'],
    ['su media de 1 h', 'su media desde el lanzamiento'],
    ['la media horaria', 'su media desde el lanzamiento'],
    ['su media horaria', 'su media desde el lanzamiento'],
  ],
  en: [
    ['the average pace of the past hour', 'the average pace since launch'],
    ['the average of the past hour', 'the average since launch'],
    ['the pace of the past hour', 'the pace since launch'],
    ['its 1h average', 'its average since launch'],
    ['the 1h average', 'the average since launch'],
    ['the hourly average', 'the average since launch'],
    ['its hourly average', 'its average since launch'],
  ],
};

function swapBaseline(text: string, lang: Lang): string {
  return LAUNCH_BASELINE[lang].reduce((t, [from, to]) => t.split(from).join(to), text);
}

function launchBaseline(copy: SignalCopy, lang: Lang): SignalCopy {
  const swap = (text: string) => swapBaseline(text, lang);
  return { headlines: copy.headlines.map(swap), aiLines: copy.aiLines.map(swap), bullet: swap(copy.bullet) };
}

function leadCopy(c: Ctx): RankedCopy {
  return signalCopies(c)[0] ?? { code: 'generic', copy: PACKS[c.lang].generic(c) };
}

type Family = 'flow' | 'participation' | 'price' | 'launch' | 'quiet';

const ACTIVITY_SIGNALS: ReadonlySet<SignalCode> = new Set(['volume_surge', 'tx_acceleration', 'buyer_surge', 'fresh_launch']);

/** Below every threshold and without any activity signal we can describe. */
function isQuiet(c: Ctx): boolean {
  return c.d.severity === null && !signalCopies(c).some((x) => x.code !== 'generic' && ACTIVITY_SIGNALS.has(x.code));
}

function familyOf(code: SignalCode | 'generic'): Family {
  if (code === 'buyer_surge' || code === 'holder_growth' || code === 'social_attention') return 'participation';
  if (code === 'momentum' || code === 'liquidity_growth') return 'price';
  if (code === 'fresh_launch') return 'launch';
  return 'flow';
}

/* ───────────── article parts ───────────── */

function headline(c: Ctx, lead: RankedCopy): string {
  const fitting = lead.copy.headlines.filter((h) => h.length <= ARTICLE_LIMITS.headline);
  if (fitting.length) return pick(fitting, c.seed, 'headline');
  const shortest = [...lead.copy.headlines].sort((a, b) => a.length - b.length)[0] ?? PACKS[c.lang].generic(c).headlines[0]!;
  return clampText(shortest, ARTICLE_LIMITS.headline);
}

type ClauseKey = 'volume' | 'trades' | 'buyers' | 'holders' | 'price' | 'valuation';

const LEAD_CLAUSE: Partial<Record<SignalCode | 'generic', ClauseKey>> = {
  tx_acceleration: 'trades',
  fresh_launch: 'trades',
  buyer_surge: 'buyers',
  holder_growth: 'holders',
  momentum: 'price',
};

/** Opening sentence + up to two figures + an update note, shortened until it fits. */
function lede(c: Ctx, lead: RankedCopy, previous: NewsInput['previous']): string {
  const p = PACKS[c.lang];
  const phrase = lead.code === 'generic' ? p.leadPhrase.generic : p.leadPhrase[lead.code];
  const opening = p.ledeOpening(c, c.strong ? phrase[0] : phrase[1]);

  const clauses = p.clauses(c);
  const leadKey = LEAD_CLAUSE[lead.code];
  const order: ClauseKey[] = ['volume', ...(leadKey ? [leadKey] : []), 'trades', 'buyers', 'holders', 'price', 'valuation'];
  const figures = unique(order.map((k) => clauses[k]).filter((x): x is string => x !== null)).slice(0, 2);

  const update = previous ? p.update(minutesBetween(previous.createdAt, c.s.ts), escalated(previous.severity, c)) : null;
  const candidates = [
    [opening, p.figures(figures), update],
    [opening, p.figures(figures.slice(0, 1)), update],
    [opening, update],
    [opening],
  ];
  for (const parts of candidates) {
    const text = parts.filter(Boolean).join(' ');
    if (text.length <= ARTICLE_LIMITS.lede) return text;
  }
  return clampText(opening, ARTICLE_LIMITS.lede);
}

function escalated(previous: Severity, c: Ctx): boolean {
  return c.d.severity === 'BREAKING' && previous !== 'BREAKING';
}

function minutesBetween(from: number, to: number): number | null {
  const minutes = (to - from) / 60_000;
  return isNum(minutes) && minutes >= 0 ? minutes : null;
}

/* ───────────── risk ───────────── */

const CONCENTRATED_TOP10_PCT = 30;
const NOTABLE_DEV_HOLDING_PCT = 5;
const THIN_LIQUIDITY_USD = 50_000;
const WASH_TRADING_TURNOVER = 5;
const SELL_HEAVY_PCT = 55;
const VERY_YOUNG_MINUTES = 60;
const MAX_CONCERNS = 3;

type Concern =
  | { kind: 'mint' | 'freeze' | 'boosted' }
  | { kind: 'top10' | 'dev' | 'liquidity' | 'turnover' | 'sells' | 'young'; value: string };

/** Concrete, data-backed risks, most serious first. */
function riskConcerns(c: Ctx): Concern[] {
  const { s, m, f } = c;
  const out: Concern[] = [];
  const add = (kind: Extract<Concern, { value: string }>['kind'], value: string | null) => {
    if (value) out.push({ kind, value });
  };
  if (s.security?.mintAuthority === true) out.push({ kind: 'mint' });
  if (s.security?.freezeAuthority === true) out.push({ kind: 'freeze' });
  if (isNum(s.top10HolderPct) && s.top10HolderPct >= CONCENTRATED_TOP10_PCT) add('top10', f.share(s.top10HolderPct));
  const dev = s.security?.devHoldingPct;
  if (isNum(dev) && dev >= NOTABLE_DEV_HOLDING_PCT) add('dev', f.share(dev));
  if (isNum(s.liquidityUsd) && s.liquidityUsd < THIN_LIQUIDITY_USD) add('liquidity', f.usd(s.liquidityUsd));
  if (isNum(m.volumeToLiquidity) && m.volumeToLiquidity >= WASH_TRADING_TURNOVER) add('turnover', f.mult(m.volumeToLiquidity));
  if (isNum(m.sellPct) && m.sellPct >= SELL_HEAVY_PCT) add('sells', f.share(m.sellPct));
  if (s.boosted) out.push({ kind: 'boosted' });
  if (isNum(m.ageMinutes) && m.ageMinutes < VERY_YOUNG_MINUTES) add('young', f.dur(m.ageMinutes));
  return out.slice(0, MAX_CONCERNS);
}

/* ───────────── language packs ───────────── */

interface LangPack {
  signals: Record<SignalCode, CopyFn>;
  generic(c: Ctx): SignalCopy;
  /** [strong, notable] noun phrases for the lede: "una fuerte aceleración de volumen" */
  leadPhrase: Record<SignalCode | 'generic', readonly [string, string]>;
  ledeOpening(c: Ctx, phrase: string): string;
  clauses(c: Ctx): Record<ClauseKey, string | null>;
  figures(clauses: string[]): string | null;
  update(minutesAgo: number | null, escalated: boolean): string;
  contextBullets(c: Ctx): string[];
  fillerBullets(c: Ctx): string[];
  quant(c: Ctx, matches: Array<{ name: string; score: string }>): string;
  bullish(c: Ctx, family: Family): string;
  neutral(c: Ctx, family: Family): string;
  risk(c: Ctx, concerns: Concern[]): string;
}

const WINDOW_LABEL: Record<TimeWindow, string> = {
  m5: '5 min',
  m15: '15 min',
  m30: '30 min',
  h1: '1 h',
  h6: '6 h',
  h24: '24 h',
};

/** Buyer surges are scored either on acceleration or on the absolute crowd of buyers in 5 minutes. */
function buyerMode(c: Ctx, sig: AnomalySignal): { crowd: string } | { accel: string } | null {
  const crowd = c.m.uniqueBuyersM5;
  if (isNum(crowd) && sig.value === crowd) return { crowd: c.f.num(crowd)! };
  const accel = c.f.mult(c.m.buyerAcceleration);
  if (accel) return { accel };
  return isNum(crowd) ? { crowd: c.f.num(crowd)! } : null;
}

/**
 * Positive 1 h price change, the only one that fits a momentum headline. Under an
 * hour of trading it is the move since launch (`sinceLaunch`), and is written so.
 */
function risingH1(c: Ctx): { signed: string; abs: string; sinceLaunch: boolean } | null {
  const h1 = c.s.priceChangePct.h1;
  return isNum(h1) && h1 > 0 ? { signed: c.f.pct(h1)!, abs: c.f.abs(h1)!, sinceLaunch: sinceLaunch(c.m) } : null;
}

/** Below this, "transactions multiplied by 1.2" is not worth a clause. */
const NOTABLE_ACCELERATION = 1.5;

function notableAcceleration(m: DerivedMetrics): boolean {
  return isNum(m.txAcceleration) && m.txAcceleration >= NOTABLE_ACCELERATION;
}

function valuation(c: Ctx): { kind: 'mc' | 'fdv'; value: string } | null {
  const mc = c.f.usd(c.s.marketCapUsd);
  if (mc) return { kind: 'mc', value: mc };
  const fdv = c.f.usd(c.s.fdvUsd);
  return fdv ? { kind: 'fdv', value: fdv } : null;
}

/**
 * Under an hour of trading, the "1 h" window is the whole life of the pool the
 * figures come from (a token under an hour old, or a pool opened less than an hour
 * ago): its 1 h figures are since-launch figures.
 */
function sinceLaunch(m: DerivedMetrics): boolean {
  const age = m.windowAgeMinutes ?? m.ageMinutes;
  return isNum(age) && age <= 60;
}

/** Volume (and trade count) a young token has done: its whole life while it is under an hour old. */
function launchTraction(c: Ctx): { age: string; volume: string; trades: string | null; sinceLaunch: boolean } | null {
  const age = c.f.dur(c.m.ageMinutes);
  const volume = c.f.usd(c.s.volumeUsd.h1);
  if (!age || !volume || !isNum(c.m.ageMinutes)) return null;
  const h1 = c.s.txns.h1;
  const trades = h1?.buys != null && h1.sells != null ? c.f.num(h1.buys + h1.sells) : null;
  return { age, volume, trades, sinceLaunch: sinceLaunch(c.m) };
}

/** Volume-to-liquidity reading with the window it was measured on, or null below 1x. */
function turnoverFact(
  c: Ctx,
): { mult: string; liq: string; window: string; sinceLaunch: boolean; level: 'very_high' | 'high' | 'plain' } | null {
  const x = c.m.volumeToLiquidity;
  const window = volumeToLiquidityWindow(c.s, c.m.ageMinutes);
  const mult = c.f.mult(x);
  const liq = c.f.usd(c.s.liquidityUsd);
  if (!isNum(x) || x < 1 || !window || !mult || !liq) return null;
  const level = x >= WASH_TRADING_TURNOVER ? 'very_high' : x >= 2 ? 'high' : 'plain';
  return { mult, liq, window: WINDOW_LABEL[window], sinceLaunch: window === 'h1' && sinceLaunch(c.m), level };
}

const ES: LangPack = {
  signals: {
    volume_surge: (c) => {
      const x = c.f.mult(c.m.volumeAcceleration);
      if (!x) return null;
      const v5 = c.f.usd(c.s.volumeUsd.m5);
      return {
        headlines: [
          `Aceleración on-chain en ${c.sym}: volumen ${x} sobre la media de 1 h`,
          `${c.sym} dispara su volumen en ${c.chain}: ${x} sobre el ritmo de la última hora`,
          `Pico de volumen en ${c.sym}: el flujo de 5 min corre a ${x} la media horaria`,
        ],
        aiLines: [
          `El volumen de los últimos 5 minutos avanza a ${x} el ritmo medio de la última hora.`,
          'El token está mostrando una aceleración anormal de volumen durante los últimos minutos.',
        ],
        bullet: `El volumen de 5 min corre a ${x} la media de 1 h${v5 ? ` (${v5})` : ''}: entra flujo nuevo.`,
      };
    },
    tx_acceleration: (c) => {
      const x = c.f.mult(c.m.txAcceleration);
      if (!x) return null;
      const times = c.f.times(c.m.txAcceleration);
      const tpm = c.f.rate(c.m.txPerMin);
      return {
        headlines: [
          `Las transacciones de ${c.sym} se aceleran ${x} frente a la media de 1 h`,
          `Actividad on-chain al alza en ${c.sym}: operaciones a ${x} la media horaria`,
          ...(tpm ? [`${c.sym} acelera su actividad on-chain: ${tpm} transacciones por minuto`] : []),
        ],
        aiLines: [
          'El token está mostrando una aceleración anormal de actividad on-chain durante los últimos minutos.',
          `La frecuencia de operaciones se ha multiplicado por ${times} frente a la media de la última hora.`,
        ],
        bullet: `Las transacciones se aceleran ${x} frente a la media de 1 h${tpm ? `, con ${tpm} operaciones por minuto` : ''}.`,
      };
    },
    buyer_surge: (c, sig) => {
      const mode = buyerMode(c, sig);
      if (!mode) return null;
      if ('crowd' in mode) {
        return {
          headlines: [
            `Oleada de compradores en ${c.sym}: ${mode.crowd} carteras únicas en 5 min`,
            `${c.sym} atrae a ${mode.crowd} compradores únicos en cinco minutos`,
          ],
          aiLines: [
            `${mode.crowd} carteras distintas han comprado el token en los últimos 5 minutos.`,
            'La entrada de compradores únicos se ha acelerado con fuerza en los últimos minutos.',
          ],
          bullet: `${mode.crowd} carteras distintas compraron en los últimos 5 min: la demanda está repartida.`,
        };
      }
      return {
        headlines: [
          `Los compradores únicos de ${c.sym} se aceleran ${mode.accel} frente a la media de 1 h`,
          `Entrada acelerada de compradores en ${c.sym}: ${mode.accel} sobre la media horaria`,
        ],
        aiLines: ['La entrada de compradores únicos se ha acelerado con fuerza en los últimos minutos.'],
        bullet: `Los compradores únicos llegan a ${mode.accel} el ritmo medio de la última hora.`,
      };
    },
    holder_growth: (c) => {
      const g = c.m.holdersGrowthPct;
      if (!isNum(g) || g <= 0) return null;
      const [signed, abs] = [c.f.pct(g)!, c.f.abs(g)!];
      const win = c.f.dur(c.m.holdersGrowthWindowMin);
      const span = win ? `en ${win}` : 'en la última hora';
      const holders = c.f.num(c.s.holders);
      return {
        headlines: [
          `${c.sym} amplía un ${abs} su base de holders ${span}`,
          `Crecimiento acelerado de holders en ${c.sym}: ${signed} ${span}`,
        ],
        aiLines: [`La base de holders crece a un ritmo inusual: ${signed} ${span}.`],
        bullet: `Los holders aumentan un ${abs} ${span}${holders ? ` hasta ${holders}` : ''}.`,
      };
    },
    liquidity_growth: (c) => {
      const g = c.m.liquidityChangePct;
      if (!isNum(g) || g <= 0) return null;
      const [signed, abs] = [c.f.pct(g)!, c.f.abs(g)!];
      const liq = c.f.usd(c.s.liquidityUsd);
      return {
        headlines: [
          `La liquidez de ${c.sym} crece un ${abs} en la última hora`,
          ...(liq ? [`${c.sym} refuerza su liquidez: ${signed} hasta ${liq}`] : []),
        ],
        aiLines: [`La liquidez del pool aumenta un ${abs}, lo que reduce el impacto de cada operación en el precio.`],
        bullet: `La liquidez sube un ${abs} en la última hora${liq ? ` hasta ${liq}` : ''}, lo que amortigua el impacto de las operaciones.`,
      };
    },
    momentum: (c) => {
      const h1 = risingH1(c);
      const score = isNum(c.m.momentumScore) ? `${Math.round(c.m.momentumScore)}/100` : null;
      if (!h1 && !score) return null;
      return {
        headlines: h1
          ? h1.sinceLaunch
            ? [`${c.sym} gana impulso: ${h1.signed} desde su lanzamiento`, `Fuerte impulso en ${c.sym}: el precio avanza un ${h1.abs} desde su lanzamiento`]
            : [`${c.sym} gana impulso: ${h1.signed} en la última hora`, `Fuerte impulso en ${c.sym}: el precio avanza un ${h1.abs} en 1 h`]
          : [`${c.sym} gana impulso: momentum compuesto de ${score}`],
        aiLines: [
          score
            ? `El precio acelera con un momentum compuesto de ${score}.`
            : `El precio avanza un ${h1!.abs} ${h1!.sinceLaunch ? 'desde su lanzamiento' : 'en la última hora'}.`,
        ],
        bullet:
          h1 && score
            ? `El precio sube un ${h1.abs} ${h1.sinceLaunch ? 'desde su lanzamiento' : 'en 1 h'} y el momentum compuesto marca ${score}.`
            : h1
              ? `El precio sube un ${h1.abs} ${h1.sinceLaunch ? 'desde su lanzamiento' : 'en la última hora'}.`
              : `El momentum compuesto de precio marca ${score}.`,
      };
    },
    buy_pressure: (c) => {
      const pct = c.f.share(c.m.buyPct);
      if (!pct || !c.m.buySellWindow) return null;
      const win = WINDOW_LABEL[c.m.buySellWindow];
      return {
        headlines: [
          `Presión compradora en ${c.sym}: el ${pct} de las operaciones son compras`,
          `Dominio comprador en ${c.sym}: ${pct} de compras en ${win}`,
        ],
        aiLines: [`Las compras dominan el flujo de órdenes: ${pct} de las operaciones en ${win}.`],
        bullet: `Las compras suponen el ${pct} de las operaciones en ${win}.`,
      };
    },
    large_wallet_flow: (c) => {
      const avg = c.f.usd(c.m.avgTradeUsd);
      if (!avg) return null;
      const liq = c.f.usd(c.s.liquidityUsd);
      return {
        headlines: [`Operaciones de gran tamaño en ${c.sym}: ticket medio de ${avg}`],
        aiLines: [
          liq
            ? `El tamaño medio por operación (${avg}) es elevado para la liquidez del pool.`
            : `El tamaño medio por operación alcanza ${avg}.`,
        ],
        bullet: `Ticket medio de ${avg} por operación en 1 h${liq ? `, elevado frente a una liquidez de ${liq}` : ''}.`,
      };
    },
    social_attention: (c, sig) => {
      const n = c.f.num(sig.value);
      if (!n) return null;
      return {
        headlines: [`${c.sym} gana atención pública: ${n} menciones en 2 h`],
        aiLines: [`La conversación pública sobre el token se intensifica: ${n} menciones en 2 h.`],
        bullet: `${n} menciones públicas en las últimas 2 h acompañan el movimiento on-chain.`,
      };
    },
    fresh_launch: (c) => {
      const t = launchTraction(c);
      if (!t) return null;
      const span = t.sinceLaunch ? 'desde su lanzamiento' : 'en la última hora';
      const trades = t.trades ? ` en ${t.trades} operaciones` : '';
      return {
        headlines: [
          `Arranque intenso de ${c.sym} en ${c.chain}: ${t.volume} de volumen en ${t.age}`,
          `${c.sym} mueve ${t.volume} ${span}, con ${t.age} de vida`,
        ],
        // figure-bearing variants: several launch stories in a row must not share one stock sentence
        aiLines: [
          `${t.volume} de volumen${t.trades ? ` y ${t.trades} operaciones` : ''} en solo ${t.age} de vida: un arranque fuera de lo común.`,
          `Volumen inusual para un token recién creado: ${t.volume} ${span}, con ${t.age} de vida.`,
        ],
        bullet: `Con solo ${t.age} de vida, acumula ${t.volume} de volumen ${span}${trades}.`,
      };
    },
  },
  generic: (c) => ({
    headlines: [`Actividad on-chain inusual en ${c.sym} (${c.chain})`],
    aiLines: ['El token muestra una actividad on-chain fuera de lo habitual según nuestros indicadores.'],
    bullet: `La puntuación de anomalía es de ${c.d.score}/100.`,
  }),
  leadPhrase: {
    volume_surge: ['una fuerte aceleración de volumen', 'un aumento notable de volumen'],
    tx_acceleration: ['una fuerte aceleración de actividad on-chain', 'un repunte notable de actividad on-chain'],
    buyer_surge: ['una entrada acelerada de compradores', 'una entrada notable de nuevos compradores'],
    holder_growth: ['un crecimiento acelerado de su base de holders', 'un crecimiento notable de holders'],
    liquidity_growth: ['un fuerte aumento de liquidez', 'un aumento notable de liquidez'],
    momentum: ['un fuerte impulso de precio', 'un impulso de precio notable'],
    buy_pressure: ['una intensa presión compradora', 'una presión compradora sostenida'],
    large_wallet_flow: ['operaciones de tamaño inusualmente grande', 'operaciones de tamaño elevado'],
    social_attention: ['un fuerte aumento de la atención pública', 'un aumento de la atención pública'],
    fresh_launch: ['un volumen de negociación muy intenso para su edad', 'un volumen de negociación intenso para su edad'],
    generic: ['una actividad on-chain inusual', 'una actividad on-chain inusual'],
  },
  ledeOpening: (c, phrase) => {
    const age = c.f.age(c.m.ageMinutes);
    const verb = c.strong ? 'está registrando' : 'registra';
    return age ? `${c.sym}, lanzado ${age} en ${c.chain}, ${verb} ${phrase}.` : `${c.sym} (${c.chain}) ${verb} ${phrase}.`;
  },
  clauses: (c) => {
    const { s, m, f } = c;
    const volH1 = f.usd(s.volumeUsd.h1);
    const volH24 = f.usd(s.volumeUsd.h24);
    const times = notableAcceleration(m) ? f.times(m.txAcceleration) : null;
    const tpm = f.rate(m.txPerMin);
    const buyers = isNum(m.uniqueBuyersM5) && m.uniqueBuyersM5 > 0 ? f.num(m.uniqueBuyersM5) : null;
    const growth = m.holdersGrowthPct;
    const win = f.dur(m.holdersGrowthWindowMin);
    const h1 = s.priceChangePct.h1;
    const val = valuation(c);
    return {
      volume: volH1
        ? `el volumen ${sinceLaunch(m) ? 'desde su lanzamiento' : 'de 1 h'} alcanza ${volH1}`
        : volH24
          ? `el volumen de 24 h asciende a ${volH24}`
          : null,
      trades: times
        ? `las transacciones se han multiplicado por ${times} frente a ${sinceLaunch(m) ? 'su media desde el lanzamiento' : 'la media horaria'}`
        : tpm
          ? `la actividad llega a ${tpm} transacciones por minuto`
          : null,
      buyers: buyers ? `${buyers} carteras únicas han comprado en los últimos 5 minutos` : null,
      holders: isNum(growth)
        ? `los holders ${growth >= 0 ? 'han crecido' : 'se han reducido'} un ${f.abs(growth)} ${win ? `en ${win}` : 'en la última hora'}`
        : null,
      price: isNum(h1)
        ? `el precio ${h1 >= 0 ? 'sube' : 'cae'} un ${f.abs(h1)} ${sinceLaunch(m) ? 'desde su lanzamiento' : 'en la última hora'}`
        : null,
      valuation: val ? (val.kind === 'mc' ? `la capitalización se sitúa en ${val.value}` : `la FDV se sitúa en ${val.value}`) : null,
    };
  },
  figures: (clauses) => sentence(clauses, 'y'),
  update: (minutes, esc) => {
    const when = minutes !== null ? `publicada hace ${fmtDuration(minutes)}` : 'anterior';
    return esc ? `Actualiza la alerta ${when}: el nivel sube a BREAKING.` : `Actualiza la alerta ${when}.`;
  },
  contextBullets: (c) => {
    const { s, m, q, f } = c;
    const out: string[] = [];
    const turnover = turnoverFact(c);
    if (turnover) {
      const level = { very_high: ': rotación muy elevada', high: ': rotación elevada', plain: '' }[turnover.level];
      const volume = turnover.sinceLaunch ? 'El volumen desde su lanzamiento' : `El volumen de ${turnover.window}`;
      out.push(`${volume} equivale a ${turnover.mult} la liquidez del pool (${turnover.liq})${level}.`);
    }
    const breadth = f.share(q.regime.breadthPct);
    if (q.regime.label !== 'unknown' && breadth) {
      out.push(`Contexto de mercado ${q.regime.label}: el ${breadth} de los tokens jóvenes sube en 1 h.`);
    }
    const top10 = f.share(s.top10HolderPct);
    if (top10) out.push(`El top 10 de holders concentra el ${top10} del suministro.`);
    return out;
  },
  fillerBullets: (c) => [
    c.d.severity
      ? `La puntuación de anomalía es de ${c.d.score}/100, nivel ${c.d.severity}.`
      : `La puntuación de anomalía es de ${c.d.score}/100.`,
    c.dex ? `Se negocia en ${c.dex}, sobre ${c.chain}.` : `Token desplegado en ${c.chain}.`,
    'Las cifras proceden de datos on-chain en tiempo real; los valores no disponibles se omiten.',
  ],
  quant: (c, matches) => {
    const breadth = c.f.share(c.q.regime.breadthPct);
    const regime =
      c.q.regime.label !== 'unknown'
        ? `Régimen de mercado: ${c.q.regime.label}${breadth ? `, con el ${breadth} de los tokens jóvenes en positivo en 1 h` : ''}.`
        : null;
    if (!matches.length) {
      return join([
        'Ninguna metodología de la biblioteca cuantitativa muestra una similitud relevante con los datos disponibles.',
        regime,
      ]);
    }
    const list = listJoin(
      matches.map((x) => `${x.name} (${x.score})`),
      'y',
    );
    return join([
      `Las condiciones actuales se asemejan a ${list}.`,
      regime,
      'Es una medida de similitud con metodologías publicadas, no una previsión.',
    ]);
  },
  bullish: (_c, family) =>
    family === 'participation'
      ? 'Si la entrada de nuevos compradores y holders continúa, una base de participación más amplia podría sostener la actividad.'
      : family === 'price'
        ? 'Si el precio consolida sus avances con volumen sostenido y liquidez estable, el impulso podría prolongarse.'
        : family === 'launch'
          ? 'Si el volumen se sostiene más allá de la primera hora y la liquidez aguanta, el token podría consolidar su arranque.'
          : family === 'quiet'
            ? 'Si el volumen y las compras repuntaran por encima de su media de 1 h, el token podría volver a captar interés.'
            : 'Si el volumen y el ritmo de operaciones se sostienen por encima de la media de 1 h, el interés comprador podría extenderse en las próximas horas.',
  neutral: (c, family) => {
    const val = valuation(c);
    const anchor = val ? ` en torno a una ${val.kind === 'mc' ? 'capitalización' : 'FDV'} de ${val.value}` : '';
    if (family === 'quiet') return `Si la actividad se mantiene en su nivel actual, el precio podría seguir en lateral${anchor}.`;
    if (family === 'launch') return `Si la negociación se enfría tras el arranque, el precio podría estabilizarse${anchor}.`;
    return `Si la actividad vuelve a su media horaria, el precio podría lateralizar${anchor} mientras el mercado digiere el movimiento.`;
  },
  risk: (c, concerns) => {
    if (!concerns.length) {
      const liq = c.f.usd(c.s.liquidityUsd);
      return `${liq ? `Con ${liq} de liquidez` : 'Sin liquidez verificada'}, una retirada de liquidez (rug pull) o la salida de los primeros compradores podría provocar una caída brusca.`;
    }
    const parts = concerns.map((x) => {
      switch (x.kind) {
        case 'mint':
          return 'la autoridad de mint sigue activa';
        case 'freeze':
          return 'la autoridad de congelación está activa';
        case 'boosted':
          return 'el listado está promocionado (boost de pago)';
        case 'top10':
          return `el top 10 de holders concentra el ${x.value}`;
        case 'dev':
          return `el desarrollador conserva el ${x.value}`;
        case 'liquidity':
          return `la liquidez es de solo ${x.value}`;
        case 'turnover':
          return `un volumen equivalente a ${x.value} la liquidez podría reflejar wash trading`;
        case 'sells':
          return `las ventas ya suponen el ${x.value} de las operaciones`;
        case 'young':
          return `el token tiene solo ${x.value} de vida`;
      }
    });
    return `${capitalize(listJoin(parts, 'y'))}. Una retirada de liquidez (rug pull) o una reversión brusca podrían borrar el movimiento.`;
  },
};

const EN: LangPack = {
  signals: {
    volume_surge: (c) => {
      const x = c.f.mult(c.m.volumeAcceleration);
      if (!x) return null;
      const v5 = c.f.usd(c.s.volumeUsd.m5);
      return {
        headlines: [
          `On-chain acceleration in ${c.sym}: volume ${x} above its 1h average`,
          `${c.sym} volume surges on ${c.chain}: ${x} the pace of the past hour`,
          `Volume spike in ${c.sym}: 5-min flow running at ${x} the hourly average`,
        ],
        aiLines: [
          `Five-minute volume is running at ${x} the average pace of the past hour.`,
          'The token is showing an abnormal acceleration in trading volume over the last few minutes.',
        ],
        bullet: `5-min volume is running at ${x} the 1h average${v5 ? ` (${v5})` : ''}, a sign of fresh inflows.`,
      };
    },
    tx_acceleration: (c) => {
      const x = c.f.mult(c.m.txAcceleration);
      if (!x) return null;
      const times = c.f.times(c.m.txAcceleration);
      const tpm = c.f.rate(c.m.txPerMin);
      return {
        headlines: [
          `${c.sym} trades accelerate ${x} versus the 1h average`,
          `On-chain activity climbs in ${c.sym}: trades at ${x} the hourly average`,
          ...(tpm ? [`${c.sym} on-chain activity jumps to ${tpm} transactions per minute`] : []),
        ],
        aiLines: [
          'The token is showing an abnormal acceleration in on-chain activity over the last few minutes.',
          `Trade frequency has multiplied by ${times} versus the average of the past hour.`,
        ],
        bullet: `Transactions are running ${x} above the 1h average${tpm ? `, at ${tpm} trades per minute` : ''}.`,
      };
    },
    buyer_surge: (c, sig) => {
      const mode = buyerMode(c, sig);
      if (!mode) return null;
      if ('crowd' in mode) {
        return {
          headlines: [
            `Buyer rush in ${c.sym}: ${mode.crowd} unique wallets in 5 minutes`,
            `${c.sym} draws ${mode.crowd} unique buyers in five minutes`,
          ],
          aiLines: [
            `${mode.crowd} different wallets have bought the token in the last 5 minutes.`,
            'Unique-buyer inflow has accelerated sharply over the last few minutes.',
          ],
          bullet: `${mode.crowd} distinct wallets bought in the last 5 min, so demand is broadly spread.`,
        };
      }
      return {
        headlines: [
          `${c.sym} unique buyers accelerate ${mode.accel} versus the 1h average`,
          `Accelerating buyer inflow in ${c.sym}: ${mode.accel} above the hourly average`,
        ],
        aiLines: ['Unique-buyer inflow has accelerated sharply over the last few minutes.'],
        bullet: `Unique buyers are arriving at ${mode.accel} the average pace of the past hour.`,
      };
    },
    holder_growth: (c) => {
      const g = c.m.holdersGrowthPct;
      if (!isNum(g) || g <= 0) return null;
      const [signed, abs] = [c.f.pct(g)!, c.f.abs(g)!];
      const win = c.f.dur(c.m.holdersGrowthWindowMin);
      const span = win ? `in ${win}` : 'within the hour';
      const holders = c.f.num(c.s.holders);
      return {
        headlines: [`${c.sym} grows its holder base ${abs} ${span}`, `Rapid holder growth in ${c.sym}: ${signed} ${span}`],
        aiLines: [`The holder base is growing at an unusual pace: ${signed} ${span}.`],
        bullet: `Holders are up ${abs} ${span}${holders ? `, to ${holders}` : ''}.`,
      };
    },
    liquidity_growth: (c) => {
      const g = c.m.liquidityChangePct;
      if (!isNum(g) || g <= 0) return null;
      const [signed, abs] = [c.f.pct(g)!, c.f.abs(g)!];
      const liq = c.f.usd(c.s.liquidityUsd);
      return {
        headlines: [
          `${c.sym} liquidity grows ${abs} within the hour`,
          ...(liq ? [`${c.sym} deepens its pool: liquidity ${signed} to ${liq}`] : []),
        ],
        aiLines: [`Pool liquidity is up ${abs}, which reduces the price impact of each trade.`],
        bullet: `Liquidity is up ${abs} over the past hour${liq ? ` to ${liq}` : ''}, cushioning the price impact of trades.`,
      };
    },
    momentum: (c) => {
      const h1 = risingH1(c);
      const score = isNum(c.m.momentumScore) ? `${Math.round(c.m.momentumScore)}/100` : null;
      if (!h1 && !score) return null;
      return {
        headlines: h1
          ? h1.sinceLaunch
            ? [`${c.sym} gains momentum: ${h1.signed} since launch`, `Strong momentum in ${c.sym}: price up ${h1.abs} since launch`]
            : [`${c.sym} gains momentum: ${h1.signed} in the past hour`, `Strong momentum in ${c.sym}: price up ${h1.abs} in 1h`]
          : [`${c.sym} gains momentum: composite score ${score}`],
        aiLines: [
          score
            ? `Price is accelerating, with a composite momentum score of ${score}.`
            : `Price is up ${h1!.abs} ${h1!.sinceLaunch ? 'since launch' : 'over the past hour'}.`,
        ],
        bullet:
          h1 && score
            ? `Price is up ${h1.abs} ${h1.sinceLaunch ? 'since launch' : 'in 1h'} and composite momentum reads ${score}.`
            : h1
              ? `Price is up ${h1.abs} ${h1.sinceLaunch ? 'since launch' : 'over the past hour'}.`
              : `Composite price momentum reads ${score}.`,
      };
    },
    buy_pressure: (c) => {
      const pct = c.f.share(c.m.buyPct);
      if (!pct || !c.m.buySellWindow) return null;
      const win = WINDOW_LABEL[c.m.buySellWindow];
      return {
        headlines: [`Buy pressure in ${c.sym}: ${pct} of trades are buys`, `Buyers dominate ${c.sym}: ${pct} buys over ${win}`],
        aiLines: [`Buys dominate order flow: ${pct} of trades over ${win}.`],
        bullet: `Buys account for ${pct} of trades over ${win}.`,
      };
    },
    large_wallet_flow: (c) => {
      const avg = c.f.usd(c.m.avgTradeUsd);
      if (!avg) return null;
      const liq = c.f.usd(c.s.liquidityUsd);
      return {
        headlines: [`Large trades in ${c.sym}: average ticket of ${avg}`],
        aiLines: [
          liq
            ? `The average trade size (${avg}) is large relative to pool liquidity.`
            : `The average trade size reaches ${avg}.`,
        ],
        bullet: `Average trade of ${avg} over 1h${liq ? `, large against ${liq} of liquidity` : ''}.`,
      };
    },
    social_attention: (c, sig) => {
      const n = c.f.num(sig.value);
      if (!n) return null;
      return {
        headlines: [`${c.sym} draws public attention: ${n} mentions in 2h`],
        aiLines: [`Public discussion of the token is picking up: ${n} mentions in 2h.`],
        bullet: `${n} public mentions in the past 2h accompany the on-chain move.`,
      };
    },
    fresh_launch: (c) => {
      const t = launchTraction(c);
      if (!t) return null;
      const span = t.sinceLaunch ? 'since launch' : 'over the past hour';
      const trades = t.trades ? ` across ${t.trades} trades` : '';
      return {
        headlines: [
          `Busy start for ${c.sym} on ${c.chain}: ${t.volume} traded in ${t.age}`,
          `${c.sym} trades ${t.volume} ${span}, ${t.age} after launch`,
        ],
        aiLines: [
          `${t.volume} traded${t.trades ? ` across ${t.trades} trades` : ''} in just ${t.age}: an unusually busy start.`,
          `Unusual volume for a brand-new token: ${t.volume} ${span}, ${t.age} after launch.`,
        ],
        bullet: `Only ${t.age} old and already at ${t.volume} of volume ${span}${trades}.`,
      };
    },
  },
  generic: (c) => ({
    headlines: [`Unusual on-chain activity in ${c.sym} (${c.chain})`],
    aiLines: ['The token is showing on-chain activity outside its usual range by our indicators.'],
    bullet: `The anomaly score is ${c.d.score}/100.`,
  }),
  leadPhrase: {
    volume_surge: ['a sharp acceleration in trading volume', 'a notable rise in trading volume'],
    tx_acceleration: ['a sharp acceleration in on-chain activity', 'a notable pickup in on-chain activity'],
    buyer_surge: ['an accelerating inflow of buyers', 'a notable inflow of new buyers'],
    holder_growth: ['rapid growth in its holder base', 'notable growth in holders'],
    liquidity_growth: ['a sharp increase in liquidity', 'a notable increase in liquidity'],
    momentum: ['strong price momentum', 'notable price momentum'],
    buy_pressure: ['intense buy pressure', 'sustained buy pressure'],
    large_wallet_flow: ['unusually large trades', 'large trades'],
    social_attention: ['a sharp rise in public attention', 'rising public attention'],
    fresh_launch: ['very heavy trading volume for its age', 'heavy trading volume for its age'],
    generic: ['unusual on-chain activity', 'unusual on-chain activity'],
  },
  ledeOpening: (c, phrase) => {
    const age = c.f.age(c.m.ageMinutes);
    return age ? `${c.sym}, launched ${age} on ${c.chain}, is seeing ${phrase}.` : `${c.sym} (${c.chain}) is seeing ${phrase}.`;
  },
  clauses: (c) => {
    const { s, m, f } = c;
    const volH1 = f.usd(s.volumeUsd.h1);
    const volH24 = f.usd(s.volumeUsd.h24);
    const x = notableAcceleration(m) ? f.mult(m.txAcceleration) : null;
    const tpm = f.rate(m.txPerMin);
    const buyers = isNum(m.uniqueBuyersM5) && m.uniqueBuyersM5 > 0 ? f.num(m.uniqueBuyersM5) : null;
    const growth = m.holdersGrowthPct;
    const win = f.dur(m.holdersGrowthWindowMin);
    const h1 = s.priceChangePct.h1;
    const val = valuation(c);
    return {
      volume: volH1
        ? `${sinceLaunch(m) ? 'volume since launch' : '1h volume'} has reached ${volH1}`
        : volH24
          ? `24h volume stands at ${volH24}`
          : null,
      trades: x
        ? `transactions are running at ${x} ${sinceLaunch(m) ? 'the average since launch' : 'the hourly average'}`
        : tpm
          ? `activity has reached ${tpm} transactions per minute`
          : null,
      buyers: buyers ? `${buyers} unique wallets have bought in the last 5 minutes` : null,
      holders: isNum(growth)
        ? `holders have ${growth >= 0 ? 'grown' : 'fallen'} ${f.abs(growth)} ${win ? `in ${win}` : 'within the hour'}`
        : null,
      price: isNum(h1)
        ? `the price is ${h1 >= 0 ? 'up' : 'down'} ${f.abs(h1)} ${sinceLaunch(m) ? 'since launch' : 'over the past hour'}`
        : null,
      valuation: val ? (val.kind === 'mc' ? `market cap stands at ${val.value}` : `fully diluted valuation stands at ${val.value}`) : null,
    };
  },
  figures: (clauses) => sentence(clauses, 'and'),
  update: (minutes, esc) => {
    const when = minutes !== null ? `published ${fmtDuration(minutes)} ago` : 'issued earlier';
    return esc ? `Updates the alert ${when}, now escalated to BREAKING.` : `Updates the alert ${when}.`;
  },
  contextBullets: (c) => {
    const { s, m, q, f } = c;
    const out: string[] = [];
    const turnover = turnoverFact(c);
    if (turnover) {
      const level = { very_high: ', a very high turnover', high: ', a high turnover', plain: '' }[turnover.level];
      const volume = turnover.sinceLaunch ? 'Volume since launch' : `${turnover.window} volume`;
      out.push(`${volume} equals ${turnover.mult} the pool's liquidity (${turnover.liq})${level}.`);
    }
    const breadth = f.share(q.regime.breadthPct);
    if (q.regime.label !== 'unknown' && breadth) {
      out.push(`Market context is ${q.regime.label}: ${breadth} of young tokens are up over 1h.`);
    }
    const top10 = f.share(s.top10HolderPct);
    if (top10) out.push(`The top 10 holders control ${top10} of supply.`);
    return out;
  },
  fillerBullets: (c) => [
    c.d.severity
      ? `The anomaly score is ${c.d.score}/100, at ${c.d.severity} level.`
      : `The anomaly score is ${c.d.score}/100.`,
    c.dex ? `Trades on ${c.dex}, on ${c.chain}.` : `Deployed on ${c.chain}.`,
    'Figures come from real-time on-chain data; unavailable values are omitted.',
  ],
  quant: (c, matches) => {
    const breadth = c.f.share(c.q.regime.breadthPct);
    const regime =
      c.q.regime.label !== 'unknown'
        ? `Market regime: ${c.q.regime.label}${breadth ? `, with ${breadth} of young tokens up over 1h` : ''}.`
        : null;
    if (!matches.length) {
      return join(['No methodology in the quant library shows a relevant similarity with the available data.', regime]);
    }
    const list = listJoin(
      matches.map((x) => `${x.name} (${x.score})`),
      'and',
    );
    return join([
      `Current conditions resemble ${list}.`,
      regime,
      'This measures similarity to published methodologies; it is not a forecast.',
    ]);
  },
  bullish: (_c, family) =>
    family === 'participation'
      ? 'If new buyers and holders keep arriving, a broader participation base could sustain the activity.'
      : family === 'price'
        ? 'If price holds its gains on sustained volume and stable liquidity, the momentum could extend.'
        : family === 'launch'
          ? 'If volume holds beyond the first hour and liquidity stays in place, the token could consolidate its debut.'
          : family === 'quiet'
            ? 'If volume and buying picked up above the 1h average, the token could draw renewed interest.'
            : 'If volume and trade frequency hold above the 1h average, buying interest could extend over the coming hours.',
  neutral: (c, family) => {
    const val = valuation(c);
    const anchor = val ? ` around a ${val.value} ${val.kind === 'mc' ? 'market cap' : 'FDV'}` : '';
    if (family === 'quiet') return `If activity stays at its current level, price could keep trading sideways${anchor}.`;
    if (family === 'launch') return `If trading cools after the launch burst, price could settle${anchor}.`;
    return `If activity reverts to its hourly average, price could move sideways${anchor} while the market digests the move.`;
  },
  risk: (c, concerns) => {
    if (!concerns.length) {
      const liq = c.f.usd(c.s.liquidityUsd);
      return `${liq ? `With ${liq} of liquidity` : 'With unverified liquidity'}, a liquidity pull (rug) or early buyers exiting could trigger a sharp drop.`;
    }
    const parts = concerns.map((x) => {
      switch (x.kind) {
        case 'mint':
          return 'mint authority is still enabled';
        case 'freeze':
          return 'freeze authority is enabled';
        case 'boosted':
          return 'the listing is a paid promotion (boost)';
        case 'top10':
          return `the top 10 holders hold ${x.value}`;
        case 'dev':
          return `the developer holds ${x.value}`;
        case 'liquidity':
          return `liquidity is only ${x.value}`;
        case 'turnover':
          return `volume at ${x.value} the liquidity could reflect wash trading`;
        case 'sells':
          return `sells already account for ${x.value} of trades`;
        case 'young':
          return `the token is only ${x.value} old`;
      }
    });
    return `${capitalize(listJoin(parts, 'and'))}. A liquidity pull (rug) or a sharp reversal could erase the move.`;
  },
};

const PACKS: Record<Lang, LangPack> = { es: ES, en: EN };

/* ───────────── text helpers ───────────── */

/** FNV-1a: stable across runs and platforms. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick<T>(items: readonly T[], seed: string, slot: string): T {
  if (!items.length) throw new Error(`no variants for ${slot}`);
  return items[hash(`${seed}:${slot}`) % items.length]!;
}

function sentence(clauses: string[], and: string): string | null {
  if (!clauses.length) return null;
  return `${capitalize(listJoin(clauses, and))}.`;
}

/** "a, b and c" */
export function listJoin(items: string[], and: string): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

function join(parts: Array<string | null>): string {
  return parts.filter(Boolean).join(' ');
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

const UNPRINTABLE = /[\p{Extended_Pictographic}\p{Cc}\p{Cf}\p{Co}\u{FE0F}]/gu;

/** Provider-supplied label without emoji/control characters, collapsed whitespace, at most `max` characters. */
export function plainText(s: string, max: number): string {
  const chars = [...s.replace(UNPRINTABLE, '').replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** "pump-fun" → "Pump Fun", "uniswap_v3" → "Uniswap V3" */
function prettyDex(dex: string): string {
  return dex
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ');
}
