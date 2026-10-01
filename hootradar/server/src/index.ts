/*
 * HootRadar bootstrap: configuration → storage → AI → chains → engine → HTTP,
 * then the scanner and the distribution worker. Graceful shutdown on SIGINT/SIGTERM.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { EngineState, MarketRegime } from '../../shared/types.js';
import { engineState, initClaude, setEngineStatus } from './ai/claude.js';
import { createChainAdapters } from './chains/registry.js';
import { loadConfig, type AppConfig } from './config.js';
import { openDb, type Db } from './db/db.js';
import { DistributionQueue } from './distribution/queue.js';
import { Bus } from './engine/bus.js';
import { Pipeline } from './engine/pipeline.js';
import { Scanner } from './engine/scanner.js';
import { createServer } from './http/server.js';
import { errMsg, logger } from './log.js';
import { computeRegime } from './quant/regime.js';
import { quickMentions } from './research/intel/index.js';
import { RadarService } from './research/radar.js';

const log = logger('hootradar');

/** Both server/src/index.ts (dev) and the bundled server/dist/index.js sit two levels below the repo root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DB_FILE = 'hootradar.db';
const REGIME_TTL_MS = 30_000;
const REGIME_WINDOW_MS = 2 * 60 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
/** in-flight scan cycles may be waiting on a slow AI write; shutdown does not wait for them past this */
const SCANNER_STOP_BUDGET_MS = 7_000;
/** in-flight requests get this long to finish before every remaining socket is destroyed */
const SERVER_CLOSE_GRACE_MS = 3_000;

interface Runtime {
  app: FastifyInstance;
  scanner: Scanner;
  distribution: DistributionQueue;
  db: Db;
}

let runtime: Runtime | null = null;
let stopping = false;

async function main(): Promise<void> {
  const startedAt = Date.now();
  const envFiles = loadDotEnv();
  const config = loadConfig();

  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, DB_FILE));
  initClaude(config);

  const adapters = createChainAdapters(config.chains, { maxTokenAgeHours: config.scan.maxTokenAgeHours });
  const bus = new Bus();
  const distribution = new DistributionQueue({ db, config });
  const regime = regimeProvider(db);
  const pipeline = new Pipeline({ db, bus, config, adapters, distribution, regime, mentions: quickMentions });
  const scanner = new Scanner({ adapters, db, bus, pipeline, config });
  const radar = new RadarService({ adapters, db, config, regime });
  const webDist = locateWebDist();

  const app = await createServer({
    config,
    db,
    bus,
    scanner,
    radar,
    distribution,
    startedAt,
    webDist,
    trustProxy: trustProxyFromEnv(process.env.TRUST_PROXY),
  });
  runtime = { app, scanner, distribution, db };

  const address = await app.listen({ port: config.port, host: config.host });
  trackEngineStatus(bus, config.chains);
  scanner.start();
  distribution.start();
  logBanner({ config, address, webDist, envFiles, distribution });
}

/* ───────────── environment ───────────── */

/**
 * Fills process.env from `.env` in the repo root, then in the working directory.
 * Variables already set in the environment win. LOG_LEVEL is read when the
 * logger module loads, before this runs, so it must come from the real environment.
 */
function loadDotEnv(): string[] {
  const loaded: string[] = [];
  for (const file of new Set([join(REPO_ROOT, '.env'), resolve('.env')])) {
    if (!existsSync(file)) continue;
    try {
      for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
        if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
      }
      loaded.push(file);
    } catch (e) {
      log.warn('could not read env file', { file, error: errMsg(e) });
    }
  }
  return loaded;
}

/** TRUST_PROXY: true/1 trusts every hop; any other value is a comma-separated list of proxy addresses/CIDRs. */
function trustProxyFromEnv(raw: string | undefined): boolean | string {
  const value = raw?.trim() ?? '';
  const lower = value.toLowerCase();
  if (value === '' || ['0', 'false', 'no', 'off'].includes(lower)) return false;
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  return value;
}

/** WEB_DIST when set and built, else <repo>/web/dist when built, else null (API only; Vite serves the UI in dev). */
function locateWebDist(): string | null {
  const configured = process.env.WEB_DIST?.trim() || null;
  const candidates = [configured, join(REPO_ROOT, 'web', 'dist')].filter((d): d is string => d != null);
  for (const dir of candidates) {
    const abs = resolve(dir);
    if (existsSync(join(abs, 'index.html'))) return abs;
    if (dir === configured) log.warn('WEB_DIST has no index.html, ignoring it', { dir: abs });
  }
  return null;
}

/* ───────────── engine ───────────── */

/** Market regime over the tracked universe, recomputed at most every 30 s. Never throws. */
function regimeProvider(db: Db): () => MarketRegime {
  let current: MarketRegime | null = null;
  return () => {
    const now = Date.now();
    if (current && now - current.computedAt < REGIME_TTL_MS) return current;
    try {
      current = computeRegime(db.latestSnapshots(now - REGIME_WINDOW_MS), now);
    } catch (e) {
      log.warn('regime computation failed', { error: errMsg(e) });
      current = { label: 'unknown', breadthPct: null, medianH1ChangePct: null, sampleSize: 0, computedAt: now };
    }
    return current;
  };
}

/** 'active' once a chain scans successfully; 'degraded' while the latest cycle of every chain failed. */
function trackEngineStatus(bus: Bus, chains: readonly string[]): void {
  const latestOk = new Map<string, boolean>();
  bus.on('scan', (e) => {
    if (stopping) return;
    latestOk.set(e.chain, e.ok);
    const allFailing = chains.every((c) => latestOk.get(c) === false);
    const anyOk = [...latestOk.values()].some(Boolean);
    const next: EngineState['status'] | null = allFailing ? 'degraded' : anyOk ? 'active' : null;
    if (!next || next === engineState().status) return;
    setEngineStatus(next);
    if (next === 'active') log.info('engine active');
    else log.warn('engine degraded: every chain is failing', { lastError: e.error });
  });
}

function logBanner(b: {
  config: AppConfig;
  address: string;
  webDist: string | null;
  envFiles: string[];
  distribution: DistributionQueue;
}): void {
  const engine = engineState();
  log.info(`HootRadar listening on ${b.address}`, {
    port: b.config.port,
    chains: b.config.chains,
    ai: engine.ai === 'claude' ? `claude (${engine.model})` : 'rules (no ANTHROPIC_API_KEY)',
    lang: b.config.lang,
    distribution: b.distribution.enabledChannels(),
    web: b.webDist ?? 'not built, API only',
    dataDir: resolve(b.config.dataDir),
    envFiles: b.envFiles,
  });
}

/* ───────────── lifecycle ───────────── */

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { reason });
  const force = setTimeout(() => {
    log.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();

  const rt = runtime;
  if (rt) {
    rt.distribution.stop();
    await Promise.allSettled([
      Promise.race([rt.scanner.stop(), sleep(SCANNER_STOP_BUDGET_MS, undefined, { ref: false })]),
      closeServer(rt.app),
    ]);
    try {
      rt.db.close();
    } catch (e) {
      log.warn('database close failed', { error: errMsg(e) });
    }
  }
  log.info('stopped');
  process.exit(exitCode);
}

/**
 * Graceful first (event streams are ended by the server's preClose hook), then
 * forceful: sockets that never carried a request (browser preconnects, pooled
 * client connections) would otherwise hold close() open until they time out.
 */
async function closeServer(app: FastifyInstance): Promise<void> {
  const grace = setTimeout(() => app.server.closeAllConnections(), SERVER_CLOSE_GRACE_MS);
  grace.unref();
  try {
    await app.close();
  } finally {
    clearTimeout(grace);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) {
      log.warn(`second ${signal}, exiting now`);
      process.exit(1);
    }
    void shutdown(signal, 0);
  });
}

process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', { error: errMsg(reason) });
});

process.on('uncaughtException', (e) => {
  log.error('uncaught exception', { error: errMsg(e), stack: e.stack ?? null });
  void shutdown('uncaughtException', 1);
});

main().catch((e: unknown) => {
  log.error('startup failed', { error: errMsg(e) });
  void shutdown('startup failure', 1);
});
