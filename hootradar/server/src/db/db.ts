import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import type {
  ChainId,
  DetectionEvent,
  DistributionItem,
  NewsArticle,
  RadarReport,
  Severity,
  TokenSnapshot,
} from '../../../shared/types.js';

const HOUR_MS = 3_600_000;
const SNAPSHOT_RETENTION_MS = 48 * HOUR_MS;
const TOKEN_RETENTION_MS = 48 * HOUR_MS;
const RADAR_RETENTION_MS = 7 * 24 * HOUR_MS;
/**
 * A refresh that returns exactly the same market data as the last stored
 * observation of a token is not stored again unless this much time has passed.
 * Quiet young tokens are refreshed every ~20 s and often do not change; this
 * keeps the snapshot table much smaller without losing any information that
 * history-based metrics rely on (the oldest row of an unchanged run is kept,
 * and the token row still records the sighting).
 */
const SNAPSHOT_COALESCE_MS = 5 * 60_000;

type Row = Record<string, SQLOutputValue>;

export interface DbCounts {
  tokensAnalyzed: number;
  anomalies: number;
  breaking: number;
  articles: number;
  distributed: number;
  perChainTokens: Record<string, number>;
}

export interface ArticleQuery {
  limit: number;
  before?: number;
  chain?: ChainId;
  severity?: Severity;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  key        TEXT PRIMARY KEY,
  chain      TEXT NOT NULL,
  address    TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_chain_last_seen ON tokens(chain, last_seen);
CREATE INDEX IF NOT EXISTS idx_tokens_last_seen ON tokens(last_seen, chain);

CREATE TABLE IF NOT EXISTS snapshots (
  id    INTEGER PRIMARY KEY,
  key   TEXT NOT NULL,
  chain TEXT NOT NULL,
  ts    INTEGER NOT NULL,
  json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_key_ts ON snapshots(key, ts);
CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);

CREATE TABLE IF NOT EXISTS detections (
  id       TEXT PRIMARY KEY,
  key      TEXT NOT NULL,
  chain    TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  severity TEXT NOT NULL,
  score    REAL NOT NULL,
  json     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_detections_ts ON detections(ts);
CREATE INDEX IF NOT EXISTS idx_detections_key_ts ON detections(key, ts);

CREATE TABLE IF NOT EXISTS articles (
  id       TEXT PRIMARY KEY,
  key      TEXT NOT NULL,
  chain    TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  severity TEXT NOT NULL,
  json     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_ts ON articles(ts);
CREATE INDEX IF NOT EXISTS idx_articles_key_ts ON articles(key, ts);

CREATE TABLE IF NOT EXISTS distribution (
  id         TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  channel    TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_distribution_article ON distribution(article_id);
CREATE INDEX IF NOT EXISTS idx_distribution_status ON distribution(status);

CREATE TABLE IF NOT EXISTS radar (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_radar_created_at ON radar(created_at);
`;

/** Canonical address form: EVM addresses are case-insensitive, Solana base58 is not. */
export function normalizeAddress(chain: ChainId, address: string): string {
  return chain === 'solana' ? address : address.toLowerCase();
}

/** Primary key of a token across all tables: `chain:normalizedAddress`. */
export function tokenKey(chain: ChainId, address: string): string {
  return `${chain}:${normalizeAddress(chain, address)}`;
}

export function openDb(file: string): Db {
  if (file !== ':memory:' && !file.startsWith('file:')) {
    mkdirSync(dirname(file), { recursive: true });
  }
  return new Db(new DatabaseSync(file));
}

export class Db {
  private readonly statements = new Map<string, StatementSync>();
  /** last stored fingerprint per token key, used to coalesce unchanged snapshots */
  private readonly lastStored = new Map<string, { ts: number; hash: string }>();

  constructor(private readonly db: DatabaseSync) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
  }

  /* ───────────── tokens & snapshots ───────────── */

  /** Registers a token or refreshes its row; an older observation never overwrites a newer one. */
  upsertToken(s: TokenSnapshot): void {
    this.writeToken(s, JSON.stringify(s));
  }

  /**
   * Records one observation. Also keeps the token row current (a snapshot always
   * implies a known token), so callers need not call `upsertToken` as well.
   */
  insertSnapshot(s: TokenSnapshot): void {
    const json = JSON.stringify(s);
    this.writeToken(s, json);

    const key = tokenKey(s.chain, s.address);
    const hash = marketFingerprint(s);
    const last = this.lastStored.get(key);
    if (last && last.hash === hash && s.ts >= last.ts && s.ts - last.ts < SNAPSHOT_COALESCE_MS) return;

    this.run('INSERT INTO snapshots (key, chain, ts, json) VALUES (?, ?, ?, ?)', key, s.chain, s.ts, json);
    if (!last || s.ts >= last.ts) this.lastStored.set(key, { ts: s.ts, hash });
  }

  private writeToken(s: TokenSnapshot, json: string): void {
    this.run(
      `INSERT INTO tokens (key, chain, address, symbol, name, created_at, first_seen, last_seen, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         symbol     = CASE WHEN excluded.last_seen >= tokens.last_seen AND excluded.symbol <> '' THEN excluded.symbol ELSE tokens.symbol END,
         name       = CASE WHEN excluded.last_seen >= tokens.last_seen AND excluded.name <> '' THEN excluded.name ELSE tokens.name END,
         created_at = CASE
                        WHEN tokens.created_at IS NULL THEN excluded.created_at
                        WHEN excluded.created_at IS NULL THEN tokens.created_at
                        ELSE MIN(tokens.created_at, excluded.created_at)
                      END,
         first_seen = MIN(tokens.first_seen, excluded.first_seen),
         json       = CASE WHEN excluded.last_seen >= tokens.last_seen THEN excluded.json ELSE tokens.json END,
         last_seen  = MAX(tokens.last_seen, excluded.last_seen)`,
      tokenKey(s.chain, s.address),
      s.chain,
      s.address,
      s.symbol,
      s.name,
      s.createdAt,
      s.ts,
      s.ts,
      json,
    );
  }

  /** Snapshots of one token observed at or after `sinceTs`, oldest → newest. */
  history(chain: ChainId, address: string, sinceTs: number): TokenSnapshot[] {
    return this.all<TokenSnapshot>(
      'SELECT json FROM snapshots WHERE key = ? AND ts >= ? ORDER BY ts ASC, id ASC',
      tokenKey(chain, address),
      sinceTs,
    );
  }

  /** The most recent snapshot of every token observed since `sinceTs`, newest first. */
  latestSnapshots(sinceTs: number, limit?: number): TokenSnapshot[] {
    return this.all<TokenSnapshot>(
      `SELECT json FROM (
         SELECT json, ts, ROW_NUMBER() OVER (PARTITION BY key ORDER BY ts DESC, id DESC) AS rn
         FROM snapshots WHERE ts >= ?
       ) WHERE rn = 1
       ORDER BY ts DESC
       LIMIT ?`,
      sinceTs,
      limit ?? -1,
    );
  }

  /**
   * Addresses (original casing) of young tokens on a chain, most recently seen first.
   * Age uses the provider creation time, or our first sighting when it is unknown.
   */
  trackedAddresses(chain: ChainId, maxAgeHours: number, limit: number, now: number = Date.now()): string[] {
    const rows = this.rows(
      `SELECT address FROM tokens
       WHERE chain = ? AND COALESCE(created_at, first_seen) >= ?
       ORDER BY last_seen DESC
       LIMIT ?`,
      chain,
      now - maxAgeHours * HOUR_MS,
      limit,
    );
    return rows.map((r) => String(r.address));
  }

  /* ───────────── detections ───────────── */

  insertDetection(e: DetectionEvent): void {
    this.run(
      `INSERT OR REPLACE INTO detections (id, key, chain, ts, severity, score, json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      e.id,
      tokenKey(e.chain, e.address),
      e.chain,
      e.ts,
      e.severity,
      e.score,
      JSON.stringify(e),
    );
  }

  recentDetections(limit: number): DetectionEvent[] {
    return this.all<DetectionEvent>('SELECT json FROM detections ORDER BY ts DESC, rowid DESC LIMIT ?', limit);
  }

  detectionsFor(chain: ChainId, address: string, limit: number): DetectionEvent[] {
    return this.all<DetectionEvent>(
      'SELECT json FROM detections WHERE key = ? ORDER BY ts DESC, rowid DESC LIMIT ?',
      tokenKey(chain, address),
      limit,
    );
  }

  lastDetectionFor(chain: ChainId, address: string): DetectionEvent | null {
    return this.detectionsFor(chain, address, 1)[0] ?? null;
  }

  /* ───────────── articles ───────────── */

  insertArticle(a: NewsArticle): void {
    this.run(
      'INSERT OR REPLACE INTO articles (id, key, chain, ts, severity, json) VALUES (?, ?, ?, ?, ?, ?)',
      a.id,
      tokenKey(a.chain, a.address),
      a.chain,
      a.createdAt,
      a.severity,
      JSON.stringify(a),
    );
  }

  getArticle(id: string): NewsArticle | null {
    return this.one<NewsArticle>('SELECT json FROM articles WHERE id = ?', id);
  }

  /** Newest first; `before` is an exclusive `createdAt` cursor. */
  listArticles(q: ArticleQuery): NewsArticle[] {
    return this.all<NewsArticle>(
      `SELECT json FROM articles
       WHERE (?1 IS NULL OR ts < ?1)
         AND (?2 IS NULL OR chain = ?2)
         AND (?3 IS NULL OR severity = ?3)
       ORDER BY ts DESC, rowid DESC
       LIMIT ?4`,
      q.before ?? null,
      q.chain ?? null,
      q.severity ?? null,
      q.limit,
    );
  }

  lastArticleFor(chain: ChainId, address: string): NewsArticle | null {
    return this.one<NewsArticle>(
      'SELECT json FROM articles WHERE key = ? ORDER BY ts DESC, rowid DESC LIMIT 1',
      tokenKey(chain, address),
    );
  }

  articlesSince(ts: number): number {
    return this.count('SELECT COUNT(*) AS n FROM articles WHERE ts >= ?', ts);
  }

  /* ───────────── distribution ───────────── */

  insertDistribution(d: DistributionItem): void {
    this.run(
      `INSERT OR REPLACE INTO distribution (id, article_id, channel, status, created_at, sent_at, json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      d.id,
      d.articleId,
      d.channel,
      d.status,
      d.createdAt,
      d.sentAt,
      JSON.stringify(d),
    );
  }

  updateDistribution(id: string, patch: Partial<Pick<DistributionItem, 'status' | 'sentAt' | 'error'>>): void {
    const current = this.one<DistributionItem>('SELECT json FROM distribution WHERE id = ?', id);
    if (!current) return;
    const next: DistributionItem = { ...current, ...patch };
    this.run(
      'UPDATE distribution SET status = ?, sent_at = ?, json = ? WHERE id = ?',
      next.status,
      next.sentAt,
      JSON.stringify(next),
      id,
    );
  }

  distributionFor(articleId: string): DistributionItem[] {
    return this.all<DistributionItem>(
      'SELECT json FROM distribution WHERE article_id = ? ORDER BY created_at ASC, rowid ASC',
      articleId,
    );
  }

  /** Items waiting to be sent (status 'queued'), oldest first. */
  pendingDistribution(limit: number): DistributionItem[] {
    return this.all<DistributionItem>(
      `SELECT json FROM distribution WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      limit,
    );
  }

  /* ───────────── radar ───────────── */

  saveRadar(r: RadarReport): void {
    this.run('INSERT OR REPLACE INTO radar (id, created_at, json) VALUES (?, ?, ?)', r.id, r.createdAt, JSON.stringify(r));
  }

  getRadar(id: string): RadarReport | null {
    return this.one<RadarReport>('SELECT json FROM radar WHERE id = ?', id);
  }

  /* ───────────── maintenance ───────────── */

  counts(sinceTs: number): DbCounts {
    const perChainTokens: Record<string, number> = {};
    let tokensAnalyzed = 0;
    // Every snapshot refreshes its token's last_seen, so "distinct tokens with a snapshot since"
    // is a count over the small tokens table instead of a COUNT(DISTINCT) over all snapshots.
    for (const r of this.rows('SELECT chain, COUNT(*) AS n FROM tokens WHERE last_seen >= ? GROUP BY chain', sinceTs)) {
      const n = Number(r.n);
      perChainTokens[String(r.chain)] = n;
      tokensAnalyzed += n;
    }
    const detections = this.rows(
      `SELECT COUNT(*) AS anomalies, COALESCE(SUM(severity = 'BREAKING'), 0) AS breaking
       FROM detections WHERE ts >= ?`,
      sinceTs,
    )[0];
    return {
      tokensAnalyzed,
      anomalies: Number(detections?.anomalies ?? 0),
      breaking: Number(detections?.breaking ?? 0),
      articles: this.articlesSince(sinceTs),
      distributed: this.count(`SELECT COUNT(*) AS n FROM distribution WHERE status = 'sent' AND sent_at >= ?`, sinceTs),
      perChainTokens,
    };
  }

  /** Drops snapshots and stale tokens older than 48 h and radar reports older than 7 days. */
  prune(now: number): void {
    this.run('DELETE FROM snapshots WHERE ts < ?', now - SNAPSHOT_RETENTION_MS);
    this.run('DELETE FROM tokens WHERE last_seen < ?', now - TOKEN_RETENTION_MS);
    this.run('DELETE FROM radar WHERE created_at < ?', now - RADAR_RETENTION_MS);
    for (const [key, last] of this.lastStored) {
      if (now - last.ts >= SNAPSHOT_COALESCE_MS) this.lastStored.delete(key);
    }
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  /* ───────────── helpers ───────────── */

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.stmt(sql).run(...params);
  }

  private rows(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.stmt(sql).all(...params);
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.rows(sql, ...params).map((r) => JSON.parse(String(r.json)) as T);
  }

  private one<T>(sql: string, ...params: SQLInputValue[]): T | null {
    const row = this.stmt(sql).get(...params);
    return row ? (JSON.parse(String(row.json)) as T) : null;
  }

  private count(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.stmt(sql).get(...params)?.n ?? 0);
  }
}

/** Hash of everything in a snapshot except its observation time. */
function marketFingerprint(s: TokenSnapshot): string {
  const { ts: _ts, ...rest } = s;
  return createHash('sha1').update(JSON.stringify(rest)).digest('base64');
}
