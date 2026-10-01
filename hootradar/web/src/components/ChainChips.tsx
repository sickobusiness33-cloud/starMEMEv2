import clsx from 'clsx';
import type { ChainInfo } from '@shared/types';
import { useStore } from '../store';
import { useClock } from '../lib/time';
import { fmtDateTime, shortSince } from '../lib/format';
import { STATUS_COLOR } from '../lib/chains';

const STATUS_LABEL: Record<ChainInfo['status'], string> = {
  scanning: 'scanning',
  degraded: 'degraded',
  down: 'down',
  idle: 'idle',
};

/** `● SOL 12s` per chain — dot = scan status, seconds since the last real scan. */
export function ChainChips({ className }: { className?: string }) {
  const chains = useStore((s) => s.stats?.chains);
  const now = useClock();
  if (!chains || chains.length === 0) return <div className={clsx('chain-chips', className)} aria-hidden="true" />;
  return (
    <ul className={clsx('chain-chips', className)} aria-label="Chain scanners">
      {chains.map((c) => {
        const since = c.lastScanAt ? shortSince(c.lastScanAt, now) : '—';
        const title = [
          `${c.name}: ${STATUS_LABEL[c.status]}`,
          c.lastScanAt ? `last scan ${fmtDateTime(c.lastScanAt)}` : 'no scan yet',
          c.lastError ? `last error: ${c.lastError}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={c.id} className="chain-chip" data-status={c.status} title={title}>
            <span className="dot" style={{ ['--dot' as string]: STATUS_COLOR[c.status] }} aria-hidden="true" />
            <span className="chain-chip__name">{c.short}</span>
            <span className="chain-chip__since">{since}</span>
            <span className="sr-only">{STATUS_LABEL[c.status]}</span>
          </li>
        );
      })}
    </ul>
  );
}
