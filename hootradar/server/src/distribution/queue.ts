import { randomUUID } from 'node:crypto';
import type {
  DistributionChannel,
  DistributionItem,
  DistributionStatus,
  NewsArticle,
  Severity,
} from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/db.js';
import { errMsg, logger } from '../log.js';
import { formatForChannels } from './formats.js';

const log = logger('distribution');

const TICK_MS = 3000;
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;
/** Retry delays: 5 s, then 10 s (a Retry-After header can only lengthen them). */
const BASE_BACKOFF_MS = 5000;
const SEND_TIMEOUT_MS = 10_000;
const MAX_ERROR_CHARS = 300;
const USER_AGENT = 'HootRadar/0.1 (+crypto intelligence newsroom)';
const TELEGRAM_API = 'https://api.telegram.org';

const SEVERITY_RANK: Record<Severity, number> = { WATCH: 1, ALERT: 2, BREAKING: 3 };

export interface DistributionDeps {
  db: Db;
  config: AppConfig;
  /** test seams */
  fetch?: typeof fetch;
  now?: () => number;
}

/** A failed delivery; `permanent` failures (bad URL, revoked webhook) are not retried. */
class SendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/**
 * Turns published articles into channel posts. Configured channels at or above
 * the minimum severity are 'queued' and delivered by the worker; everything else
 * is 'ready' for manual copy-paste. X is never posted automatically.
 */
export class DistributionQueue {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** delivery attempts so far, per item id (in memory: a restart simply retries from zero) */
  private readonly attempts = new Map<string, { count: number; nextAt: number }>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly d: DistributionDeps) {
    this.fetchFn = d.fetch ?? fetch;
    this.now = d.now ?? Date.now;
  }

  enqueue(a: NewsArticle): DistributionItem[] {
    const createdAt = this.now();
    const items = formatForChannels(a, this.d.config.publicBaseUrl).map(
      ({ channel, payload }): DistributionItem => ({
        id: randomUUID(),
        articleId: a.id,
        channel,
        payload,
        status: this.initialStatus(channel, a.severity),
        createdAt,
        sentAt: null,
        error: null,
      }),
    );
    for (const item of items) this.d.db.insertDistribution(item);
    return items;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Channels that deliver automatically (X is manual-only). */
  enabledChannels(): DistributionChannel[] {
    const all: DistributionChannel[] = ['telegram', 'discord', 'webhook'];
    return all.filter((c) => this.configured(c));
  }

  sentSince(ts: number): number {
    return this.d.db.counts(ts).distributed;
  }

  /** One worker pass over queued items. Never throws; overlapping calls are skipped. */
  async flush(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const item of this.d.db.pendingDistribution(BATCH_SIZE)) {
        await this.deliver(item);
      }
    } catch (e) {
      log.error('distribution pass failed', { error: this.redact(errMsg(e)) });
    } finally {
      this.busy = false;
    }
  }

  /* ───────────── internals ───────────── */

  private initialStatus(channel: DistributionChannel, severity: Severity): DistributionStatus {
    if (channel === 'x' || !this.configured(channel)) return 'ready';
    const min = this.d.config.distribution.minSeverity;
    return SEVERITY_RANK[severity] >= SEVERITY_RANK[min] ? 'queued' : 'ready';
  }

  private configured(channel: DistributionChannel): boolean {
    const c = this.d.config.distribution;
    switch (channel) {
      case 'telegram':
        return !!(c.telegramBotToken && c.telegramChatId);
      case 'discord':
        return !!c.discordWebhookUrl;
      case 'webhook':
        return !!c.webhookUrl;
      case 'x':
        return false;
    }
  }

  private async deliver(item: DistributionItem): Promise<void> {
    const now = this.now();
    const state = this.attempts.get(item.id);
    if (state && now < state.nextAt) return;
    if (!this.configured(item.channel)) {
      // e.g. configuration changed across a restart; keep the payload for manual use
      this.d.db.updateDistribution(item.id, { status: 'ready', error: 'channel not configured' });
      return;
    }
    try {
      await this.send(item);
      this.attempts.delete(item.id);
      this.d.db.updateDistribution(item.id, { status: 'sent', sentAt: this.now(), error: null });
      log.info('distributed', { channel: item.channel, articleId: item.articleId });
    } catch (e) {
      this.onFailure(item, e, (state?.count ?? 0) + 1, now);
    }
  }

  private onFailure(item: DistributionItem, e: unknown, count: number, now: number): void {
    const error = this.redact(errMsg(e)).slice(0, MAX_ERROR_CHARS);
    const permanent = e instanceof SendError && e.permanent;
    if (permanent || count >= MAX_ATTEMPTS) {
      this.attempts.delete(item.id);
      this.d.db.updateDistribution(item.id, { status: 'failed', error });
      log.warn('distribution failed', { channel: item.channel, articleId: item.articleId, attempts: count, error });
      return;
    }
    const backoff = BASE_BACKOFF_MS * 2 ** (count - 1);
    const retryAfter = e instanceof SendError ? (e.retryAfterMs ?? 0) : 0;
    this.attempts.set(item.id, { count, nextAt: now + Math.max(backoff, retryAfter) });
    this.d.db.updateDistribution(item.id, { error });
    log.info('distribution retry scheduled', { channel: item.channel, attempts: count, error });
  }

  private async send(item: DistributionItem): Promise<void> {
    const c = this.d.config.distribution;
    switch (item.channel) {
      case 'discord':
        await this.post(c.discordWebhookUrl!, item.payload);
        return;
      case 'webhook':
        await this.post(c.webhookUrl!, item.payload);
        return;
      case 'telegram':
        await this.sendTelegram(item.payload);
        return;
      case 'x':
        throw new SendError('X is manual-only', true);
    }
  }

  private async sendTelegram(text: string): Promise<void> {
    const c = this.d.config.distribution;
    const body = JSON.stringify({
      chat_id: c.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    const res = await this.post(`${TELEGRAM_API}/bot${c.telegramBotToken}/sendMessage`, body);
    const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (json && json.ok === false) throw new SendError(`Telegram: ${json.description ?? 'not ok'}`, true);
  }

  private async post(url: string, body: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (e) {
      throw new SendError(`network error: ${errMsg(e)}`, false);
    }
    if (res.ok) return res;
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new SendError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, isPermanentStatus(res.status), retryAfterMs(res));
  }

  /** Removes bot tokens and webhook secrets from anything that may be logged or stored. */
  private redact(s: string): string {
    const c = this.d.config.distribution;
    let out = s;
    for (const secret of [c.telegramBotToken, c.discordWebhookUrl, c.webhookUrl]) {
      if (secret) out = out.split(secret).join('[redacted]');
    }
    return out
      .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]')
      .replace(/(\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]+/g, '$1[redacted]');
  }
}

/** 4xx other than timeout/conflict/rate-limit means the request itself is wrong; retrying cannot help. */
function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 425 && status !== 429;
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const seconds = Number(v);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
