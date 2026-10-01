import { z } from 'zod';
import type { KnownChainId, Severity } from '../../shared/types.js';

const bool = z
  .string()
  .optional()
  .transform((v) => (v == null || v === '' ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

const optStr = z
  .string()
  .optional()
  .transform((v) => (v == null || v.trim() === '' ? null : v.trim()));

const EnvSchema = z.object({
  PORT: num(8787),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  PUBLIC_BASE_URL: optStr,

  ANTHROPIC_API_KEY: optStr,
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_EFFORT_NEWS: z.enum(['low', 'medium', 'high']).default('low'),
  AI_EFFORT_RESEARCH: z.enum(['low', 'medium', 'high']).default('medium'),
  AI_TIMEOUT_MS: num(45000),
  NEWS_LANG: z.enum(['es', 'en']).default('es'),

  CHAINS: z.string().default('solana,ethereum,base,bsc'),
  SCAN_INTERVAL_MS: num(30000),
  REFRESH_INTERVAL_MS: num(20000),
  MAX_TOKEN_AGE_HOURS: num(24),
  MIN_LIQUIDITY_USD: num(5000),
  MIN_VOLUME_H1_USD: num(5000),
  THRESHOLD_WATCH: num(45),
  THRESHOLD_ALERT: num(62),
  THRESHOLD_BREAKING: num(78),
  ARTICLE_COOLDOWN_MIN: num(30),
  MAX_ARTICLES_PER_HOUR: num(40),
  AUTOPUBLISH: bool,

  DISCORD_WEBHOOK_URL: optStr,
  TELEGRAM_BOT_TOKEN: optStr,
  TELEGRAM_CHAT_ID: optStr,
  DISTRIBUTION_WEBHOOK_URL: optStr,
  DISTRIBUTION_MIN_SEVERITY: z.enum(['BREAKING', 'ALERT']).default('BREAKING'),
});

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  publicBaseUrl: string | null;
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
  articleCooldownMin: number;
  maxArticlesPerHour: number;
  autopublish: boolean;
  distribution: {
    discordWebhookUrl: string | null;
    telegramBotToken: string | null;
    telegramChatId: string | null;
    webhookUrl: string | null;
    minSeverity: 'BREAKING' | 'ALERT';
  };
}

const KNOWN: KnownChainId[] = ['solana', 'ethereum', 'base', 'bsc'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = EnvSchema.parse(env);
  const chains = e.CHAINS.split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c): c is KnownChainId => (KNOWN as string[]).includes(c));
  return {
    port: e.PORT,
    host: e.HOST,
    dataDir: e.DATA_DIR,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    ai: {
      apiKey: e.ANTHROPIC_API_KEY,
      model: e.AI_MODEL,
      effortNews: e.AI_EFFORT_NEWS,
      effortResearch: e.AI_EFFORT_RESEARCH,
      timeoutMs: e.AI_TIMEOUT_MS,
    },
    lang: e.NEWS_LANG,
    chains: chains.length ? chains : KNOWN,
    scan: {
      discoverIntervalMs: Math.max(10000, e.SCAN_INTERVAL_MS),
      refreshIntervalMs: Math.max(10000, e.REFRESH_INTERVAL_MS),
      maxTokenAgeHours: e.MAX_TOKEN_AGE_HOURS,
      minLiquidityUsd: e.MIN_LIQUIDITY_USD,
      minVolumeH1Usd: e.MIN_VOLUME_H1_USD,
    },
    thresholds: { WATCH: e.THRESHOLD_WATCH, ALERT: e.THRESHOLD_ALERT, BREAKING: e.THRESHOLD_BREAKING },
    articleCooldownMin: e.ARTICLE_COOLDOWN_MIN,
    maxArticlesPerHour: e.MAX_ARTICLES_PER_HOUR,
    autopublish: e.AUTOPUBLISH ?? true,
    distribution: {
      discordWebhookUrl: e.DISCORD_WEBHOOK_URL,
      telegramBotToken: e.TELEGRAM_BOT_TOKEN,
      telegramChatId: e.TELEGRAM_CHAT_ID,
      webhookUrl: e.DISTRIBUTION_WEBHOOK_URL,
      minSeverity: e.DISTRIBUTION_MIN_SEVERITY,
    },
  };
}
