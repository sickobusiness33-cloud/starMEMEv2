import type { NewsArticle, Severity } from '@shared/types';
import { matchesFilters, useStore, type ArrivalResult } from '../store';
import { getChainMeta } from './chains';
import { fmtTicker } from './format';

/**
 * Screen-reader announcements for LIVE. New stories are batched for a moment so a
 * burst becomes one polite message ("3 new stories at the top: 1 breaking, 2 alert")
 * instead of a queue of interruptions. LiveView renders `announce` in a visually
 * hidden role="status" region; the feed list and the tape are deliberately not live
 * regions (far too chatty).
 */

const BATCH_MS = 1_500;

let pending: Array<{ article: NewsArticle; result: Exclude<ArrivalResult, 'duplicate'> }> = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function noteArrival(article: NewsArticle, result: ArrivalResult): void {
  if (result === 'duplicate') return;
  pending.push({ article, result });
  if (!timer) timer = setTimeout(flush, BATCH_MS);
}

/** "New stories were added at the top" after the reader pulls in the waiting ones. */
export function noteFlushed(count: number): void {
  if (count <= 0) return;
  useStore.getState().setAnnounce(`${plural(count, 'new story', 'new stories')} added at the top of the feed.`);
}

const SEV_WORD: Record<Severity, string> = { BREAKING: 'breaking', ALERT: 'alert', WATCH: 'watch' };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function breakdown(list: NewsArticle[]): string {
  const counts = new Map<Severity, number>();
  for (const a of list) counts.set(a.severity, (counts.get(a.severity) ?? 0) + 1);
  return (['BREAKING', 'ALERT', 'WATCH'] as const)
    .filter((sev) => counts.has(sev))
    .map((sev) => `${counts.get(sev)} ${SEV_WORD[sev]}`)
    .join(', ');
}

function flush(): void {
  timer = null;
  const batch = pending;
  pending = [];
  const s = useStore.getState();
  const shown = batch.filter((x) => x.result === 'shown' && matchesFilters(x.article, s.filters)).map((x) => x.article);
  const anyBuffered = batch.some((x) => x.result === 'buffered' && matchesFilters(x.article, s.filters));
  // counted now, not at arrival: stories pulled in meanwhile are no longer "waiting"
  const waiting = s.buffered.filter((a) => matchesFilters(a, s.filters));

  const parts: string[] = [];
  const first = shown[0];
  if (shown.length === 1 && first) {
    const chain = getChainMeta(first.chain).name;
    parts.push(`New ${SEV_WORD[first.severity]} story: ${fmtTicker(first.symbol)} on ${chain}. ${first.headline}`);
  } else if (shown.length > 1) {
    parts.push(`${shown.length} new stories at the top: ${breakdown(shown)}.`);
  }
  if (anyBuffered && waiting.length > 0) {
    parts.push(
      `${plural(waiting.length, 'new story', 'new stories')} waiting above (${breakdown(waiting)}). Use the “Show new stories” button to read ${waiting.length === 1 ? 'it' : 'them'}.`,
    );
  }
  if (parts.length > 0) s.setAnnounce(parts.join(' '));
}
