import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUANT_DISCLAIMER,
  type DerivedMetrics,
  type Detection,
  type IntelItem,
  type NewsArticle,
  type QuantResult,
  type TokenSnapshot,
} from '../../shared/types.js';
import { writeRadarBrief } from '../src/ai/brief.js';
import { CallLimiter, engineState, initClaude, QueueFullError, setEngineStatus } from '../src/ai/claude.js';
import { fmtAge, fmtDuration, fmtMult, fmtNum, fmtPct, fmtRate, fmtShare, fmtUsd } from '../src/ai/format.js';
import {
  NEWS_SYSTEM_PROMPT,
  unsupportedFigures,
  writeArticle,
  type ArticleDraft,
  type NewsInput,
} from '../src/ai/newswriter.js';
import { ARTICLE_LIMITS, writeArticleRules } from '../src/ai/rules-writer.js';
import { collectSources, inferSourceType, parsePageAge, researchWeb, toIntelItems } from '../src/ai/web-research.js';
import { loadConfig } from '../src/config.js';
import { parseGtPools, parseGtTokenInfo } from '../src/sources/geckoterminal.js';
import { emptySnapshot } from '../src/sources/merge.js';

/* The SDK client is real except for messages.create, so typed errors and constructor options are exercised. */
const sdk = vi.hoisted(() => ({ create: vi.fn(), options: [] as unknown[] }));
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic extends actual.default {
    constructor(opts: ConstructorParameters<typeof actual.default>[0]) {
      super(opts);
      sdk.options.push(opts);
      (this as unknown as { messages: unknown }).messages = { create: sdk.create };
    }
  }
  return { ...actual, default: FakeAnthropic };
});

const T0 = Date.UTC(2026, 9, 1, 21, 11);
const MIN = 60_000;
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/* ───────────── inputs built from real provider responses ───────────── */

/** "WIRED", a fresh Solana pool from GeckoTerminal, enriched with the real GT token-info response. */
function richSnapshot(): TokenSnapshot {
  const pool = parseGtPools(fixture('gt_new_pools_solana.json'), 'solana', T0).find((s) => s.symbol === 'WIRED');
  const info = parseGtTokenInfo(fixture('gt_token_info_bonk.json'));
  if (!pool || !info) throw new Error('fixture changed');
  return { ...pool, holders: info.holders, top10HolderPct: info.top10HolderPct, security: info.security };
}

const RICH_METRICS: DerivedMetrics = {
  ageMinutes: 24.4,
  txPerMin: 184,
  txAcceleration: 3.1,
  volumeAcceleration: 4.2,
  buyPct: 68,
  sellPct: 32,
  buySellWindow: 'm5',
  uniqueBuyersM5: 65,
  buyerAcceleration: 2.8,
  holdersGrowthPct: 31,
  holdersGrowthWindowMin: 22,
  liquidityChangePct: 40,
  momentumScore: 62,
  volatilityProxy: 12,
  avgTradeUsd: 2100,
  largeWalletFlow: 'high',
  volumeToLiquidity: 1.05,
  illiquidity: 0.4,
};

const RICH_DETECTION: Detection = {
  score: 81,
  severity: 'BREAKING',
  signals: [
    { code: 'tx_acceleration', label: 'Trades 3.1x vs 1h avg', value: 3.1, weight: 4.4 },
    { code: 'volume_surge', label: 'Volume 4.2x vs 1h avg', value: 4.2, weight: 12.1 },
    { code: 'holder_growth', label: '+31% holders / 22m', value: 31, weight: 7.4 },
    { code: 'buyer_surge', label: '65 unique buyers in 5m', value: 65, weight: 5.3 },
    { code: 'buy_pressure', label: '68% buys (5m)', value: 68, weight: 2.7 },
  ],
  rejected: [],
};

const RICH_QUANT: QuantResult = {
  top: null,
  matches: [
    { methodologyId: 'tsmom', name: 'Time-series momentum', family: 'momentum', score: 72.4, coverage: 0.9, rationale: 'r', factors: [] },
    { methodologyId: 'vol-breakout', name: 'Volume breakout (high-volume return premium)', family: 'breakout', score: 65.2, coverage: 0.8, rationale: 'r', factors: [] },
    { methodologyId: 'ofi', name: 'Order-flow imbalance', family: 'order_flow', score: 58, coverage: 0.7, rationale: 'r', factors: [] },
  ],
  regime: { label: 'risk-on', breadthPct: 61.5, medianH1ChangePct: 3.2, sampleSize: 120, computedAt: T0 },
  riskFlags: ['Liquidity under $10k'],
  disclaimer: QUANT_DISCLAIMER,
};
RICH_QUANT.top = RICH_QUANT.matches[0]!;

function richInput(lang: 'es' | 'en', previous: NewsArticle | null = null): NewsInput {
  return { snapshot: richSnapshot(), metrics: RICH_METRICS, detection: RICH_DETECTION, quant: RICH_QUANT, lang, previous };
}

const NULL_METRICS: DerivedMetrics = {
  ageMinutes: null,
  txPerMin: null,
  txAcceleration: null,
  volumeAcceleration: null,
  buyPct: null,
  sellPct: null,
  buySellWindow: null,
  uniqueBuyersM5: null,
  buyerAcceleration: null,
  holdersGrowthPct: null,
  holdersGrowthWindowMin: null,
  liquidityChangePct: null,
  momentumScore: null,
  volatilityProxy: null,
  avgTradeUsd: null,
  largeWalletFlow: null,
  volumeToLiquidity: null,
  illiquidity: null,
};

/** Almost nothing known: a signal without a value, unknown regime, empty market data. */
function sparseInput(lang: 'es' | 'en'): NewsInput {
  const snapshot = { ...emptySnapshot('base', '0x4ed4e862860bed51a9570b96d89af5e1b0efefed', T0), symbol: 'DEGEN', name: 'Degen' };
  return {
    snapshot,
    metrics: NULL_METRICS,
    detection: {
      score: 63,
      severity: 'ALERT',
      signals: [{ code: 'volume_surge', label: 'Volume', value: null, weight: 20 }],
      rejected: [],
    },
    quant: {
      top: null,
      matches: [],
      regime: { label: 'unknown', breadthPct: null, medianH1ChangePct: null, sampleSize: 0, computedAt: T0 },
      riskFlags: [],
      disclaimer: QUANT_DISCLAIMER,
    },
    lang,
    previous: null,
  };
}

function allText(a: ArticleDraft): string {
  return [a.headline, a.lede, a.aiLine, ...a.whyItMatters, a.quantAnalysis, ...Object.values(a.outlook)].join('\n');
}

function expectCleanCopy(text: string): void {
  expect(text).not.toMatch(/\bnull\b|\bNaN\b|\bundefined\b|Infinity|—|\[object/);
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  expect(text).not.toMatch(/\bmoon\b|\b100x\b|\bgem\b|lambo/i);
}

function expectWithinLimits(a: ReturnType<typeof writeArticleRules>): void {
  expect(a.headline.length).toBeLessThanOrEqual(ARTICLE_LIMITS.headline);
  expect(a.lede.length).toBeLessThanOrEqual(ARTICLE_LIMITS.lede);
  expect(a.aiLine.length).toBeLessThanOrEqual(ARTICLE_LIMITS.aiLine);
  expect(a.whyItMatters).toHaveLength(3);
  for (const b of a.whyItMatters) expect(b.length).toBeLessThanOrEqual(ARTICLE_LIMITS.bullet);
}

/* ───────────── SDK response helpers ───────────── */

function message(content: unknown[], stopReason: Anthropic.StopReason = 'end_turn'): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as Anthropic.Message;
}

const textMessage = (text: string, stopReason: Anthropic.StopReason = 'end_turn') =>
  message([{ type: 'text', text, citations: null }], stopReason);

const config = (env: Record<string, string> = {}) =>
  loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-key', AI_TIMEOUT_MS: '30000', ...env });

beforeEach(() => {
  sdk.create.mockReset();
  sdk.options.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

/* ───────────── format ───────────── */

describe('format helpers', () => {
  it('formats USD compactly and tiny prices with significant digits', () => {
    expect(fmtUsd(1_400_000)).toBe('$1.4M');
    expect(fmtUsd(620_000)).toBe('$620K');
    expect(fmtUsd(8_200)).toBe('$8.2K');
    expect(fmtUsd(999_960)).toBe('$1M');
    expect(fmtUsd(2_300_000_000)).toBe('$2.3B');
    expect(fmtUsd(512.3)).toBe('$512');
    expect(fmtUsd(1.234)).toBe('$1.23');
    expect(fmtUsd(0.0000123)).toBe('$0.0000123');
    expect(fmtUsd(0.00005050765)).toBe('$0.0000505');
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(-2500)).toBe('-$2.5K');
    expect(fmtUsd(null)).toBe('—');
    expect(fmtUsd(Number.NaN)).toBe('—');
  });

  it('formats signed percentages per language', () => {
    expect(fmtPct(31)).toBe('+31%');
    expect(fmtPct(-4.2)).toBe('-4.2%');
    expect(fmtPct(-4.2, undefined, 'es')).toBe('-4,2%');
    expect(fmtPct(12.345, 1)).toBe('+12.3%');
    expect(fmtPct(0.01)).toBe('0%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtShare(68.4)).toBe('68%');
    expect(fmtShare(4.56, 'es')).toBe('4,6%');
  });

  it('formats ages, durations, counts, rates and multiples', () => {
    expect(fmtAge(24.7, 'es')).toBe('hace 24 min');
    expect(fmtAge(180, 'es')).toBe('hace 3 h');
    expect(fmtAge(2 * 1440 + 5, 'es')).toBe('hace 2 d');
    expect(fmtAge(24, 'en')).toBe('24 min ago');
    expect(fmtAge(0.4, 'en')).toBe('less than 1 min ago');
    expect(fmtAge(null, 'es')).toBe('—');
    expect(fmtDuration(21.6)).toBe('22 min');
    expect(fmtNum(1284)).toBe('1,284');
    expect(fmtNum(12840, 'es')).toBe('12.840');
    expect(fmtNum(null)).toBe('—');
    expect(fmtRate(4.56, 'es')).toBe('4,6');
    expect(fmtRate(184.2)).toBe('184');
    expect(fmtMult(4.2, 'es')).toBe('4,2x');
    expect(fmtMult(12.4)).toBe('12x');
  });
});

/* ───────────── rules writer ───────────── */

describe('rules writer', () => {
  it('writes Spanish wire copy from the strongest signals with the input figures', () => {
    const input = richInput('es');
    const a = writeArticleRules(input);
    const s = input.snapshot;

    expect(a).toMatchObject({ engine: 'rules', model: null, lang: 'es' });
    expectWithinLimits(a);
    expectCleanCopy(allText(a));

    // volume_surge carries the most weight, so it leads the headline
    expect(a.headline).toContain('$WIRED');
    expect(a.headline).toContain('4,2x');
    expect(a.lede).toContain(`$WIRED, lanzado ${fmtAge(24.4, 'es')} en Solana, está registrando`);
    expect(a.lede).toContain(fmtUsd(s.volumeUsd.h1 ?? null));
    expect(a.lede).toContain('3,1');
    expect(a.quantAnalysis).toContain('Time-series momentum (72%)');
    expect(a.quantAnalysis).toContain('Volume breakout (65%)');
    expect(a.quantAnalysis).toContain('no una previsión');
    // concrete risks from the data: thin liquidity and top-10 concentration
    expect(a.outlook.risk).toContain(fmtUsd(s.liquidityUsd));
    expect(a.outlook.risk).toContain('38%');
    expect(a.outlook.bullish).toMatch(/podría/);
    expect(a.outlook.bullish).not.toMatch(/subirá|garantiz/);
  });

  it('writes the English version with English number formatting', () => {
    const a = writeArticleRules(richInput('en'));
    expectWithinLimits(a);
    expectCleanCopy(allText(a));
    expect(a.lang).toBe('en');
    expect(a.headline).toContain('4.2x');
    expect(a.lede).toContain('$WIRED, launched 24 min ago on Solana, is seeing');
    expect(a.quantAnalysis).toContain('not a forecast');
    expect(a.outlook.risk).toMatch(/liquidity is only \$2\.7K/i);
  });

  it('is deterministic for a token', () => {
    expect(writeArticleRules(richInput('es'))).toEqual(writeArticleRules(richInput('es')));
  });

  it('degrades gracefully when almost nothing is known', () => {
    for (const lang of ['es', 'en'] as const) {
      const a = writeArticleRules(sparseInput(lang));
      expectWithinLimits(a);
      expectCleanCopy(allText(a));
      expect(a.headline).toContain('$DEGEN');
      expect(a.headline).toContain('Base');
      expect(a.outlook.risk.length).toBeGreaterThan(40);
      expect(a.quantAnalysis.length).toBeGreaterThan(20);
    }
  });

  it('notes follow-ups and escalation in the lede', () => {
    const previous = { id: 'a1', createdAt: T0 - 12 * MIN, severity: 'ALERT', headline: 'x', score: 66 } as NewsArticle;
    const a = writeArticleRules(richInput('es', previous));
    expect(a.lede).toContain('Actualiza la alerta publicada hace 12 min: el nivel sube a BREAKING.');
    expect(a.lede.length).toBeLessThanOrEqual(ARTICLE_LIMITS.lede);
  });

  it('strips emoji from provider symbols and caps their length', () => {
    const input = richInput('es');
    input.snapshot = { ...input.snapshot, symbol: '🐸PEPE🐸', name: 'Pepe' };
    expect(writeArticleRules(input).headline).toContain('$PEPE');
    input.snapshot = { ...input.snapshot, symbol: 'X'.repeat(80) };
    const long = writeArticleRules(input);
    expectWithinLimits(long);
  });
});

/* ───────────── Claude news writer ───────────── */

const VALID_ARTICLE = {
  headline: 'Aceleración on-chain en $WIRED: volumen 4,2x sobre la media de 1 h',
  lede: '$WIRED, lanzado hace 24 min en Solana, está registrando una fuerte aceleración de actividad on-chain. El volumen de 1 h alcanza $2.8K y las transacciones corren a 3,1x la media.',
  aiLine: 'El token está mostrando una aceleración anormal de actividad on-chain durante los últimos minutos.',
  whyItMatters: [
    'El volumen de 5 min corre a 4,2x la media horaria.',
    'Los holders crecen un 31% en 22 min.',
    'El top 10 de holders concentra el 38% del suministro.',
  ],
  quantAnalysis:
    'Las condiciones se asemejan a Time-series momentum (72%) y Volume breakout (65%). Es una medida de similitud, no una previsión.',
  outlook: {
    bullish: 'Si el volumen se sostiene por encima de la media de 1 h, la actividad podría extenderse.',
    neutral: 'Si la actividad vuelve a su media, el precio podría lateralizar.',
    risk: 'La liquidez es de solo $2.7K y el top 10 concentra el 38%; una retirada de liquidez podría borrar el movimiento.',
  },
};

describe('Claude news writer', () => {
  it('creates the client with explicit credentials and endpoint, one retry and the configured timeout', () => {
    initClaude(config());
    expect(sdk.options).toEqual([
      expect.objectContaining({
        apiKey: 'sk-ant-test-key',
        authToken: null,
        baseURL: 'https://api.anthropic.com',
        maxRetries: 1,
        timeout: 30000,
      }),
    ]);
    expect(engineState()).toMatchObject({ ai: 'claude', model: 'claude-opus-5-5', aiError: null });
    setEngineStatus('active');
    expect(engineState().status).toBe('active');
  });

  it('uses the rules writer without an API key', async () => {
    initClaude(loadConfig({}));
    const a = await writeArticle(richInput('es'));
    expect(a.engine).toBe('rules');
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.options).toHaveLength(0);
    expect(engineState()).toMatchObject({ ai: 'rules', model: null });
  });

  it('publishes valid structured output as a Claude article', async () => {
    initClaude(config());
    sdk.create.mockResolvedValueOnce(textMessage(JSON.stringify(VALID_ARTICLE)));
    const a = await writeArticle(richInput('es'));

    expect(a).toMatchObject({ engine: 'claude', model: 'claude-opus-5-5', lang: 'es', headline: VALID_ARTICLE.headline });
    expect(a.whyItMatters).toEqual(VALID_ARTICLE.whyItMatters);
    expect(engineState().aiError).toBeNull();

    const [params, options] = sdk.create.mock.calls[0]!;
    expect(options).toEqual({ timeout: 30000 });
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
      system: [{ type: 'text', text: NEWS_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    });
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('tool_choice');
    const schema = params.output_config.format.schema;
    expect(schema.required).toEqual(['headline', 'lede', 'aiLine', 'whyItMatters', 'quantAnalysis', 'outlook']);
    expect(JSON.stringify(schema)).not.toMatch(/"maxLength"|"\$schema"/);
    // facts are pre-formatted, null-free and in the article language
    const prompt: string = params.messages[0].content;
    expect(prompt).toContain('Spanish');
    expect(prompt).toContain('"symbol":"$WIRED"');
    expect(prompt).toContain('4,2x');
    expect(prompt).not.toMatch(/null|NaN|undefined/);
  });

  it.each([
    ['invalid JSON', () => textMessage('{"headline": "cut'), /not valid JSON/],
    ['a refusal', () => message([], 'refusal'), /refusal/],
    ['a truncated answer', () => textMessage('{}', 'max_tokens'), /max_tokens/],
    ['two bullets', () => textMessage(JSON.stringify({ ...VALID_ARTICLE, whyItMatters: ['a', 'b'] })), /whyItMatters/],
    ['an overlong headline', () => textMessage(JSON.stringify({ ...VALID_ARTICLE, headline: 'A'.repeat(111) })), /headline/],
    ['an invented figure', () => textMessage(JSON.stringify({ ...VALID_ARTICLE, aiLine: 'El volumen sube un 317% en 9 minutos.' })), /figure not in facts: 317/],
    ['hype vocabulary', () => textMessage(JSON.stringify({ ...VALID_ARTICLE, aiLine: 'Rumbo a la luna: to the moon.' })), /hype/],
  ])('falls back to rules on %s and records the error', async (_name, response, error) => {
    initClaude(config());
    sdk.create.mockResolvedValueOnce(response());
    const a = await writeArticle(richInput('es'));
    expect(a.engine).toBe('rules');
    expect(a).toEqual(writeArticleRules(richInput('es')));
    expect(engineState().aiError).toMatch(error);
  });

  it('falls back on a typed authentication error and clears the error after a success', async () => {
    initClaude(config());
    sdk.create.mockRejectedValueOnce(
      new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers()),
    );
    const a = await writeArticle(richInput('en'));
    expect(a.engine).toBe('rules');
    expect(engineState().aiError).toBe('Anthropic API key rejected (401)');

    sdk.create.mockResolvedValueOnce(textMessage(JSON.stringify(VALID_ARTICLE)));
    expect((await writeArticle(richInput('es'))).engine).toBe('claude');
    expect(engineState().aiError).toBeNull();
  });

  it('never leaks the API key into the recorded error', async () => {
    initClaude(config());
    sdk.create.mockRejectedValueOnce(new Error('bad header x-api-key: sk-ant-test-key'));
    await writeArticle(richInput('es'));
    expect(engineState().aiError).not.toContain('sk-ant-test-key');
  });

  it('keeps at most two Claude calls in flight', async () => {
    initClaude(config());
    const pending: Array<(m: Anthropic.Message) => void> = [];
    sdk.create.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const writes = [writeArticle(richInput('es')), writeArticle(richInput('es')), writeArticle(richInput('es'))];
    await vi.waitFor(() => expect(sdk.create).toHaveBeenCalledTimes(2));
    pending.shift()!(textMessage(JSON.stringify(VALID_ARTICLE)));
    await vi.waitFor(() => expect(sdk.create).toHaveBeenCalledTimes(3));
    for (const resolve of pending.splice(0)) resolve(textMessage(JSON.stringify(VALID_ARTICLE)));
    const done = await Promise.all(writes);
    expect(done.map((a) => a.engine)).toEqual(['claude', 'claude', 'claude']);
  });
});

describe('CallLimiter', () => {
  it('queues beyond the active limit and rejects beyond the queue limit', async () => {
    const limiter = new CallLimiter(1, 1);
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((r) => (release = r)));
    const second = limiter.run(async () => 'second');
    await expect(limiter.run(async () => 'third')).rejects.toBeInstanceOf(QueueFullError);
    expect(limiter.inFlight).toBe(1);
    expect(limiter.queued).toBe(1);
    release();
    await first;
    await expect(second).resolves.toBe('second');
    expect(limiter.inFlight).toBe(0);
  });
});

describe('figure guard', () => {
  it('accepts figures from the facts in either decimal convention and small counts', () => {
    const facts = '{"volume":"$1.4M","accel":"4,2x","holders":"1,284"}';
    expect(unsupportedFigures('Volumen de $1,4M, 4.2x y 1284 holders en 3 escenarios', facts)).toEqual([]);
    expect(unsupportedFigures('El precio sube un 250%', facts)).toEqual(['250']);
  });
});

/* ───────────── Radar brief ───────────── */

function intel(): IntelItem[] {
  const base = { url: 'https://example.com', sourceType: 'news', provider: 'gdelt', snippet: null, matchedOn: 'symbol' } as const;
  return [
    { ...base, id: '1', title: 'WIRED token draws traders on Solana', sourceName: 'coindesk.com', publishedAt: T0 - 20 * MIN, freshness: 'LIVE' },
    { ...base, id: '2', title: 'New Meteora pools this week', sourceName: 'decrypt.co', publishedAt: T0 - 5 * 60 * MIN, freshness: 'RECENT' },
    { ...base, id: '3', title: 'Old thread', sourceName: '/biz/', publishedAt: null, freshness: 'UNKNOWN' },
  ];
}

describe('Radar brief', () => {
  it('summarizes metrics and intel freshness with the rules writer', async () => {
    initClaude(loadConfig({}));
    const input = richInput('es');
    const b = await writeRadarBrief({ ...input, intel: intel() });
    expect(b).toMatchObject({ engine: 'rules', model: null });
    expect(b.summary).toContain('$WIRED (Solana)');
    expect(b.summary).toContain(fmtUsd(input.snapshot.liquidityUsd));
    expect(b.summary).toContain('3 referencias públicas: 1 LIVE, 1 RECENT y 1 sin fecha');
    expect(b.bullets.length).toBeGreaterThanOrEqual(3);
    expect(b.bullets.length).toBeLessThanOrEqual(5);
    expect(b.bullets.join(' ')).toContain('WIRED token draws traders on Solana');
    expectCleanCopy([b.summary, ...b.bullets, ...Object.values(b.outlook)].join('\n'));
  });

  it('handles a token with no intel and no anomaly', async () => {
    initClaude(loadConfig({}));
    const input = sparseInput('en');
    const b = await writeRadarBrief({ ...input, detection: { ...input.detection, severity: null, score: 12 }, intel: [] });
    expect(b.summary).toContain('We found no public references');
    expect(b.summary).toContain('below our alert thresholds');
    expect(b.bullets.length).toBeGreaterThanOrEqual(3);
    expectCleanCopy([b.summary, ...b.bullets, ...Object.values(b.outlook)].join('\n'));
  });

  it('uses Claude structured output when configured', async () => {
    initClaude(config());
    sdk.create.mockResolvedValueOnce(
      textMessage(
        JSON.stringify({
          summary: '$WIRED registra un volumen de 1 h de $2.8K. Según coindesk.com, el token atrae operadores en Solana.',
          bullets: ['El volumen corre a 4,2x la media.', 'Hay 1 mención LIVE.', 'El top 10 concentra el 38%.'],
          outlook: VALID_ARTICLE.outlook,
        }),
      ),
    );
    const b = await writeRadarBrief({ ...richInput('es'), intel: intel() });
    expect(b).toMatchObject({ engine: 'claude', model: 'claude-opus-5-5' });
    expect(sdk.create.mock.calls[0]![0].messages[0].content).toContain('WIRED token draws traders on Solana');
  });
});

/* ───────────── web research ───────────── */

const TARGET = { chain: 'solana', address: '6cTEzP3F6NXTmDmwuLJcDUuPs1PgC7S5h8AW62Fqmngv', symbol: 'WIRED', name: 'Wired' };

const searchResult = (url: string, title: string, pageAge: string | null) => ({
  type: 'web_search_result',
  url,
  title,
  page_age: pageAge,
  encrypted_content: 'enc',
});

/** First turn is paused by the server mid-loop; the continuation finishes with a cited answer. */
function pausedThenDone(): [Anthropic.Message, Anthropic.Message] {
  const paused = message(
    [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'WIRED solana' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: [
          searchResult('https://x.com/wiredsol/status/1', '$WIRED is live on Meteora', '20 minutes ago'),
          searchResult('https://www.coindesk.com/markets/2026/10/01/solana-memes', 'Solana meme tokens heat up', '3 hours ago'),
          searchResult(`https://dexscreener.com/solana/${TARGET.address}`, 'Chart', null),
        ],
      },
      { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'Wired token' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } },
    ],
    'pause_turn',
  );
  const done = message([
    { type: 'server_tool_use', id: 'srvtoolu_3', name: 'web_search', input: { query: TARGET.address } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_3',
      content: [
        searchResult('https://x.com/wiredsol/status/1#reply', '$WIRED is live on Meteora', '20 minutes ago'),
        searchResult('https://medium.com/@wired/launch', 'Why we launched Wired', 'September 1, 2026'),
        searchResult('https://bitcointalk.org/index.php?topic=1', 'Wired discussion', '2 days ago'),
        searchResult('https://randomblog.io/wired', 'Wired on Solana', '2026-10-01T20:30:00Z'),
      ],
    },
    {
      type: 'text',
      text: 'Coverage found.',
      citations: [
        {
          type: 'web_search_result_location',
          url: 'https://www.coindesk.com/markets/2026/10/01/solana-memes',
          title: 'Solana meme tokens heat up',
          cited_text: 'Traders piled into WIRED, a token launched on Meteora.',
          encrypted_index: 'x',
        },
      ],
    },
  ]);
  return [paused, done];
}

describe('web research', () => {
  it('returns [] without an API key', async () => {
    initClaude(loadConfig({}));
    expect(await researchWeb(TARGET)).toEqual([]);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('collects dated sources across a paused turn and its continuation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    initClaude(config());
    const [paused, done] = pausedThenDone();
    sdk.create.mockResolvedValueOnce(paused).mockResolvedValueOnce(done);

    const items = await researchWeb(TARGET);

    expect(sdk.create).toHaveBeenCalledTimes(2);
    const [first, firstOpts] = sdk.create.mock.calls[0]!;
    expect(first.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
    expect(first.output_config).toEqual({ effort: 'medium' });
    expect(first).not.toHaveProperty('thinking');
    expect(firstOpts).toEqual({ timeout: 30000 });
    expect(first.messages[0].content).toContain(TARGET.address);
    // the continuation re-sends the paused assistant turn, with the remaining search budget
    const second = sdk.create.mock.calls[1]![0];
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toEqual({ role: 'assistant', content: paused.content });
    expect(second.tools[0].max_uses).toBe(3);

    expect(items.map((i) => i.url)).toEqual([
      'https://x.com/wiredsol/status/1',
      'https://randomblog.io/wired',
      'https://www.coindesk.com/markets/2026/10/01/solana-memes',
      'https://bitcointalk.org/index.php?topic=1',
      'https://medium.com/@wired/launch',
      `https://dexscreener.com/solana/${TARGET.address}`,
    ]);
    const byHost = Object.fromEntries(items.map((i) => [i.sourceName, i]));
    expect(byHost['x.com']).toMatchObject({ sourceType: 'social', freshness: 'LIVE', provider: 'claude-web', publishedAt: T0 - 20 * MIN, matchedOn: 'name' });
    expect(byHost['coindesk.com']).toMatchObject({
      sourceType: 'news',
      freshness: 'RECENT',
      snippet: 'Traders piled into WIRED, a token launched on Meteora.',
    });
    expect(byHost['medium.com']).toMatchObject({ sourceType: 'blog', freshness: 'OLD', publishedAt: Date.UTC(2026, 8, 1) });
    expect(byHost['bitcointalk.org']).toMatchObject({ sourceType: 'forum', freshness: 'OLD' });
    expect(byHost['dexscreener.com']).toMatchObject({ sourceType: 'specialized', freshness: 'UNKNOWN', publishedAt: null, matchedOn: 'contract' });
    expect(byHost['randomblog.io']).toMatchObject({ sourceType: 'article', freshness: 'LIVE', matchedOn: 'name' });
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(engineState().aiError).toBeNull();
  });

  it('stops after two continuations', async () => {
    initClaude(config());
    sdk.create.mockResolvedValue(message([{ type: 'text', text: '', citations: null }], 'pause_turn'));
    await researchWeb(TARGET);
    expect(sdk.create).toHaveBeenCalledTimes(3);
  });

  it('returns [] and records typed API errors', async () => {
    initClaude(config());
    sdk.create.mockRejectedValueOnce(
      new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers()),
    );
    expect(await researchWeb(TARGET)).toEqual([]);
    expect(engineState().aiError).toBe('Anthropic API rate limit reached (429)');
  });

  it('parses result blocks and skips search error objects', () => {
    const [paused] = pausedThenDone();
    const sources = collectSources([paused]);
    expect(sources).toHaveLength(3);
    const items = toIntelItems(sources, TARGET, T0);
    expect(items[0]).toMatchObject({ sourceName: 'x.com', freshness: 'LIVE' });
  });

  it('classifies hosts', () => {
    expect(inferSourceType('mobile.twitter.com')).toBe('social');
    expect(inferSourceType('t.me')).toBe('social');
    expect(inferSourceType('www.theblock.co')).toBe('news');
    expect(inferSourceType('wired.substack.com')).toBe('blog');
    expect(inferSourceType('forum.solana.com')).toBe('forum');
    expect(inferSourceType('www.geckoterminal.com')).toBe('specialized');
    expect(inferSourceType('example.org')).toBe('article');
  });

  it('parses page_age formats', () => {
    expect(parsePageAge('October 1, 2026', T0)).toBe(Date.UTC(2026, 9, 1));
    expect(parsePageAge('Oct 1, 2026', T0)).toBe(Date.UTC(2026, 9, 1));
    expect(parsePageAge('1 Oct 2026', T0)).toBe(Date.UTC(2026, 9, 1));
    expect(parsePageAge('Sept. 30, 2026', T0)).toBe(Date.UTC(2026, 8, 30));
    expect(parsePageAge('3 hours ago', T0)).toBe(T0 - 180 * MIN);
    expect(parsePageAge('an hour ago', T0)).toBe(T0 - 60 * MIN);
    expect(parsePageAge('2 days ago', T0)).toBe(T0 - 2 * 1440 * MIN);
    expect(parsePageAge('5 mins ago', T0)).toBe(T0 - 5 * MIN);
    expect(parsePageAge('yesterday', T0)).toBe(Date.UTC(2026, 8, 30));
    expect(parsePageAge('2026-10-01T20:30:00Z', T0)).toBe(Date.UTC(2026, 9, 1, 20, 30));
    expect(parsePageAge('Thu, 01 Oct 2026 19:00:00 GMT', T0)).toBe(Date.UTC(2026, 9, 1, 19));
    expect(parsePageAge('soon', T0)).toBeNull();
    expect(parsePageAge('', T0)).toBeNull();
    expect(parsePageAge(null, T0)).toBeNull();
    expect(parsePageAge('2027-05-01', T0)).toBeNull();
    expect(parsePageAge('January 1, 1990', T0)).toBeNull();
  });
});
