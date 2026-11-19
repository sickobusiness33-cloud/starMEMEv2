import type { RadarStage, RadarStageStatus } from '@shared/types';
import { useClock } from '../lib/time';
import { fmtMs } from '../lib/format';

const STATUS_TEXT: Record<RadarStageStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  error: 'Error',
};

/**
 * RESOLVE · ON-CHAIN · HOLDERS · QUANT · WEB · AI — status dot + message per stage.
 * Durations are server-side deltas; a running stage is timed against the
 * server clock using the skew estimated from report frames.
 */
export function StageStepper(props: {
  stages: RadarStage[];
  skewMs: number | null;
  engine?: 'claude' | 'rules' | null;
  /** the investigation is over: phones fold the checklist into a compact 3 × 2 summary */
  final?: boolean;
}) {
  const { stages, skewMs, engine, final } = props;
  return (
    <ol className="stepper" aria-label="Investigation progress" data-final={final ? '' : undefined}>
      {stages.map((s, i) => (
        <li key={s.id} className="step" data-status={s.status} title={final ? (s.message ?? undefined) : undefined}>
          <span className="step__rail" aria-hidden="true" />
          <span className="step__head">
            <span className="step__dot" aria-hidden="true" />
            <span className="step__index mono" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className="step__label">{s.id === 'ai' && engine === 'rules' ? 'Brief' : s.label}</span>
            <span className="sr-only">: {STATUS_TEXT[s.status]}</span>
            {s.status === 'running' ? (
              <RunningFor startedAt={s.startedAt} skewMs={skewMs} />
            ) : (
              <span className="step__time mono">{duration(s)}</span>
            )}
          </span>
          <span className="step__msg" title={s.message ?? undefined}>
            {s.message ?? (s.status === 'pending' ? 'Waiting' : s.status === 'running' ? 'Working…' : STATUS_TEXT[s.status])}
          </span>
        </li>
      ))}
    </ol>
  );
}

function duration(s: RadarStage): string {
  if (s.startedAt === null || s.endedAt === null) return '';
  return fmtMs(s.endedAt - s.startedAt);
}

function RunningFor({ startedAt, skewMs }: { startedAt: number | null; skewMs: number | null }) {
  const now = useClock();
  if (startedAt === null || skewMs === null) return <span className="step__time mono" />;
  const ms = Math.max(0, now - skewMs - startedAt);
  return <span className="step__time mono">{ms < 1000 ? '<1 s' : `${Math.floor(ms / 1000)} s`}</span>;
}

/** Static stage list shown while the investigation is being created (before the first report frame). */
export const STAGE_PLACEHOLDERS: RadarStage[] = [
  { id: 'resolve', label: 'Resolve', status: 'running', message: 'Starting investigation…', startedAt: null, endedAt: null },
  { id: 'onchain', label: 'On-chain', status: 'pending', message: null, startedAt: null, endedAt: null },
  { id: 'holders', label: 'Holders', status: 'pending', message: null, startedAt: null, endedAt: null },
  { id: 'quant', label: 'Quant', status: 'pending', message: null, startedAt: null, endedAt: null },
  { id: 'web', label: 'Web intel', status: 'pending', message: null, startedAt: null, endedAt: null },
  { id: 'ai', label: 'AI brief', status: 'pending', message: null, startedAt: null, endedAt: null },
];
