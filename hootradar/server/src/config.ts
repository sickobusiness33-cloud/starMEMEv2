import { z } from 'zod';
import type { KnownChainId, Severity } from '../../shared/types.js';

const TRUE_WORDS = ['1', 'true', 'yes', 'on'];
const FALSE_WORDS = ['0', 'false', 'no', 'off'];

/** true/false/1/0/yes/no/on/off (any case); empty = default. Anything else is a startup error, never a silent false. */
const bool = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v == null || v.trim() === '') return undefined;
    const word = v.trim().toLowerCase();
    if (TRUE_WORDS.includes(word)) return true;
    if (FALSE_WORDS.includes(word)) return false;
    ctx.addIssue({ code: 'custom', message: `expected true or false, got "${v}"` });
    return z.NEVER;
  });

type NumRule = { min?: number; max?: number; int?: boolean };

/** Empty or unset = `def`; otherwise a finite number within the rule. */
const num = (def: number, rule: NumRule = {}) => {
  let n = z.number().finite();
  if (rule.int) n = n.int();
  if (rule.min !== undefined) n = n.min(rule.min);
  if (rule.max !== undefined) n = n.max(rule.max);
  return z
    .string()
    .optional()
    .transform((v) => (v == null || v.trim() === '' ? def : Number(v)))
    .pipe(n);
};
const count = (def: number) => num(def, { min: 0, int: true });
const usdAmount = (def: number) => num(def, { min: 0 });
const millis = (def: number) => num(def, { min: 1, int: true });
const threshold = (def: number) => num(def, { min: 0, max: 101 });

const optStr = z
  .string()
  .optional()
  .transform((v) => (v == null || v.trim() === '' ? null : v.trim()));

const EnvSchema = z
  .object({
    PORT: num(8787, { min: 0, max: 65535, int: true }),
    HOST: z.string().default('0.0.0.0'),
    DATA_DIR: z.string().default('./data'),
    PUBLIC_BASE_URL: optStr,
    TRUST_PROXY: optStr,

    ANTHROPIC_API_KEY: optStr,
    AI_MODEL: z.string().default('claude-opus-5-5'),
    AI_EFFORT_NEWS: z.enum(['low', 'medium', 'high']).default('low'),
    AI_EFFORT_RESEARCH: z.enum(['low', 'medium', 'high']).default('medium'),
    AI_TIMEOUT_MS: millis(45000),
    NEWS_LANG: z.enum(['es', 'en']).default('es'),

    CHAINS: z.string().default('solana,ethereum,base,bsc'),
    SCAN_INTERVAL_MS: millis(30000),
    REFRESH_INTERVAL_MS: millis(20000),
    MAX_TOKEN_AGE_HOURS: num(24, { min: 0.1 }),
    /*
     * Detection defaults, calibrated by replaying live snapshots from all four chains
     * (Oct 2026) through the scorer. Tokens under $10K of liquidity or $10K of 1 h
     * volume are dust: one wallet moves them, so they never reach the feed. Among the
     * rest, the per-token score maximum has a median under 10 and a top decile around
     * 20-30; only standout launches ($300K+ traded in minutes, hundreds of unique
     * buyers) and multi-signal surges of older tokens clear 42. That puts roughly
     * 10-15 ALERT/BREAKING articles an hour into the feed, about twice as many WATCH
     * events, and keeps BREAKING (60: several signal families saturated at once) rare.
     */
    MIN_LIQUIDITY_USD: usdAmount(10000),
    MIN_VOLUME_H1_USD: usdAmount(10000),
    /*
     * BREAKING also needs a market of real size. Live, tokens with $12K of 1 h volume
     * and a $31K market cap reached BREAKING on score alone, and two BREAKING tokens
     * rugged minutes later: below either minimum the story is published as ALERT.
     */
    BREAKING_MIN_LIQUIDITY_USD: usdAmount(25000),
    BREAKING_MIN_VOLUME_H1_USD: usdAmount(75000),
    THRESHOLD_WATCH: threshold(22),
    THRESHOLD_ALERT: threshold(42),
    THRESHOLD_BREAKING: threshold(60),
    ARTICLE_COOLDOWN_MIN: count(30),
    MAX_ARTICLES_PER_HOUR: count(30),
    AUTOPUBLISH: bool,

    /** Claude web search in Radar (paid per search); off keeps the free intel providers only */
    RADAR_WEB_RESEARCH: bool,
    /** Claude calls (web research + brief) that Radar searches may start per hour, across all visitors */
    RADAR_AI_CALLS_PER_HOUR: count(60),

    DISCORD_WEBHOOK_URL: optStr,
    TELEGRAM_BOT_TOKEN: optStr,
    TELEGRAM_CHAT_ID: optStr,
    DISTRIBUTION_WEBHOOK_URL: optStr,
    DISTRIBUTION_MIN_SEVERITY: z.enum(['BREAKING', 'ALERT']).default('BREAKING'),
  })
  .superRefine((e, ctx) => {
    if (!(e.THRESHOLD_WATCH < e.THRESHOLD_ALERT && e.THRESHOLD_ALERT <= e.THRESHOLD_BREAKING)) {
      ctx.addIssue({
        code: 'custom',
        path: ['THRESHOLD_WATCH'],
        message: `thresholds must satisfy WATCH < ALERT <= BREAKING (got ${e.THRESHOLD_WATCH} / ${e.THRESHOLD_ALERT} / ${e.THRESHOLD_BREAKING})`,
      });
    }
  });

/** Fastify `trustProxy`: never "trust every hop" (a client-chosen X-Forwarded-For would become request.ip). */
export type TrustProxy = false | string | ((address: string, hop: number) => boolean);

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  publicBaseUrl: string | null;
  /** how `request.ip` is derived behind a reverse proxy (rate limits key on it) */
  trustProxy: TrustProxy;
  ai: {
    apiKey: string | null;
    model: string;
    effortNews: 'low' | 'medium' | 'high';
    effortResearch: 'low' | 'medium' | 'high';
    timeoutMs: number;
  };
  lang: 'es' | 'en';
  chains: KnownChainId[];
  scan: {
    discoverIntervalMs: number;
    refreshIntervalMs: number;
    maxTokenAgeHours: number;
    minLiquidityUsd: number;
    minVolumeH1Usd: number;
  };
  thresholds: Record<Severity, number>;
  /** market size BREAKING requires; below it a BREAKING score is published as ALERT */
  breaking: { minLiquidityUsd: number; minVolumeH1Usd: number };
  articleCooldownMin: number;
  maxArticlesPerHour: number;
  autopublish: boolean;
  radar: {
    /** run Claude web search in Radar (only when an API key is configured) */
    webResearch: boolean;
    /** Claude calls Radar may start per hour across all visitors; beyond it briefs fall back to rules */
    aiCallsPerHour: number;
  };
  distribution: {
    discordWebhookUrl: string | null;
    telegramBotToken: string | null;
    telegramChatId: string | null;
    webhookUrl: string | null;
    minSeverity: 'BREAKING' | 'ALERT';
  };
  /** non-fatal configuration notes for the startup log */
  warnings: string[];
}

const KNOWN: KnownChainId[] = ['solana', 'ethereum', 'base', 'bsc'];

/** Invalid configuration: the message names every offending variable. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const warnings: string[] = [];
  const trust = parseTrustProxy(e.TRUST_PROXY);
  if (trust.warning) warnings.push(trust.warning);
  return {
    port: e.PORT,
    host: e.HOST,
    dataDir: e.DATA_DIR,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    trustProxy: trust.value,
    ai: {
      apiKey: e.ANTHROPIC_API_KEY,
      model: e.AI_MODEL,
      effortNews: e.AI_EFFORT_NEWS,
      effortResearch: e.AI_EFFORT_RESEARCH,
      timeoutMs: e.AI_TIMEOUT_MS,
    },
    lang: e.NEWS_LANG,
    chains: parseChains(e.CHAINS),
    scan: {
      discoverIntervalMs: Math.max(10000, e.SCAN_INTERVAL_MS),
      refreshIntervalMs: Math.max(10000, e.REFRESH_INTERVAL_MS),
      maxTokenAgeHours: e.MAX_TOKEN_AGE_HOURS,
      minLiquidityUsd: e.MIN_LIQUIDITY_USD,
      minVolumeH1Usd: e.MIN_VOLUME_H1_USD,
    },
    thresholds: { WATCH: e.THRESHOLD_WATCH, ALERT: e.THRESHOLD_ALERT, BREAKING: e.THRESHOLD_BREAKING },
    breaking: { minLiquidityUsd: e.BREAKING_MIN_LIQUIDITY_USD, minVolumeH1Usd: e.BREAKING_MIN_VOLUME_H1_USD },
    articleCooldownMin: e.ARTICLE_COOLDOWN_MIN,
    maxArticlesPerHour: e.MAX_ARTICLES_PER_HOUR,
    autopublish: e.AUTOPUBLISH ?? true,
    radar: {
      webResearch: e.RADAR_WEB_RESEARCH ?? true,
      aiCallsPerHour: e.RADAR_AI_CALLS_PER_HOUR,
    },
    distribution: {
      discordWebhookUrl: e.DISCORD_WEBHOOK_URL,
      telegramBotToken: e.TELEGRAM_BOT_TOKEN,
      telegramChatId: e.TELEGRAM_CHAT_ID,
      webhookUrl: e.DISTRIBUTION_WEBHOOK_URL,
      minSeverity: e.DISTRIBUTION_MIN_SEVERITY,
    },
    warnings,
  };
}

/**
 * Comma-separated chain ids; empty = all four. An unknown id is a startup error:
 * silently dropping it (or falling back to every chain) would scan chains the
 * operator excluded and spend provider budgets on them.
 */
export function parseChains(raw: string): KnownChainId[] {
  const names = raw
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return [...KNOWN];
  const unknown = names.filter((c) => !(KNOWN as string[]).includes(c));
  if (unknown.length) {
    throw new ConfigError(`CHAINS: unknown chain ${unknown.map((c) => `"${c}"`).join(', ')} (known: ${KNOWN.join(', ')})`);
  }
  return [...new Set(names as KnownChainId[])];
}

/**
 * TRUST_PROXY:
 *  - empty / false: no proxy, request.ip is the socket peer;
 *  - a number N: trust the N nearest hops (N reverse proxies in front of the app).
 *    Safe only when the app is reachable through those proxies alone;
 *  - a comma-separated list of proxy IPs/CIDRs (preferred): only those are trusted;
 *  - true / yes / on: formerly "trust every hop", which let any client pick its own
 *    request.ip through X-Forwarded-For. It now means one hop, with a warning.
 */
export function parseTrustProxy(raw: string | null | undefined): { value: TrustProxy; warning: string | null } {
  const value = raw?.trim() ?? '';
  const lower = value.toLowerCase();
  if (value === '' || FALSE_WORDS.includes(lower)) return { value: false, warning: null };
  if (/^\d+$/.test(value)) return { value: trustHops(Number(value)), warning: null };
  if (TRUE_WORDS.includes(lower)) {
    return {
      value: trustHops(1),
      warning:
        'TRUST_PROXY=true no longer trusts every hop (clients could spoof X-Forwarded-For); trusting 1 proxy hop. Set it to your proxy IPs/CIDRs.',
    };
  }
  return { value, warning: null };
}

function trustHops(hops: number): TrustProxy {
  if (hops <= 0) return false;
  // proxy-addr walks from the socket peer (hop 0) towards the client
  return (_address: string, hop: number) => hop < hops;
}
