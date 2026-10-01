import { memo } from 'react';
import NumberFlow from '@number-flow/react';
import type { Stats } from '@shared/types';
import { useStore, type ConnState } from '../store';
import { useClock } from '../lib/time';
import { fmtClock, shortSince } from '../lib/format';
import { LogoMark } from './Logo';

export function TopBar() {
  return (
    <div className="topbar">
      <div className="topbar__inner">
        <a className="brand" href="#/live" aria-label="HootRadar, live feed">
          <LogoMark size={22} />
          <span className="brand__name">HOOTRADAR</span>
        </a>
        <EnginePill />
        <StatRow />
        <Clock />
      </div>
    </div>
  );
}

/* ───────────── engine pill ───────────── */

type PillState = 'active' | 'booting' | 'degraded' | 'offline';

function pillModel(stats: Stats | null, conn: ConnState, retryAt: number | null, now: number) {
  if (conn === 'offline') return { state: 'offline' as PillState, text: 'OFFLINE', sub: 'NO NETWORK', title: 'Your device is offline.' };
  if (!stats || conn !== 'open') {
    const retry = retryAt && retryAt > now ? ` · RETRY ${shortSince(now, retryAt)}` : '';
    const text = stats ? 'RECONNECTING' : 'CONNECTING';
    return {
      state: 'offline' as PillState,
      text,
      sub: `STREAM${retry}`,
      title: stats ? 'Live stream interrupted — numbers below are the last values received.' : 'Connecting to the engine…',
    };
  }
  const { engine } = stats;
  const sub = engine.ai === 'claude' ? `CLAUDE · ${engine.model ?? 'model unknown'}` : 'RULES ENGINE';
  const aiNote = engine.aiError ? ` Last AI error: ${engine.aiError}` : '';
  if (engine.status === 'starting') return { state: 'booting' as PillState, text: 'BOOTING', sub, title: `Engine starting.${aiNote}` };
  if (engine.status === 'degraded') {
    return {
      state: 'degraded' as PillState,
      text: engine.ai === 'claude' ? 'AI ENGINE DEGRADED' : 'ENGINE DEGRADED · RULES',
      sub,
      title: `Engine degraded.${aiNote}`,
    };
  }
  return {
    state: 'active' as PillState,
    text: engine.ai === 'claude' ? 'AI ENGINE ACTIVE' : 'ENGINE ACTIVE · RULES',
    sub,
    title: engine.ai === 'claude' ? `News written by Claude (${engine.model ?? 'model unknown'}).${aiNote}` : 'News written by the deterministic rules engine (no AI key configured).',
  };
}

function EnginePill() {
  const stats = useStore((s) => s.stats);
  const conn = useStore((s) => s.conn);
  const retryAt = useStore((s) => s.retryAt);
  // the retry countdown needs seconds; only subscribe to the clock while it is shown
  return retryAt ? <EnginePillTicking stats={stats} conn={conn} retryAt={retryAt} /> : <EnginePillView model={pillModel(stats, conn, null, 0)} />;
}

function EnginePillTicking({ stats, conn, retryAt }: { stats: Stats | null; conn: ConnState; retryAt: number }) {
  const now = useClock();
  return <EnginePillView model={pillModel(stats, conn, retryAt, now)} />;
}

const EnginePillView = memo(function EnginePillView({ model }: { model: ReturnType<typeof pillModel> }) {
  return (
    <div className="engine" data-state={model.state} title={model.title}>
      <span className="engine__dot" aria-hidden="true" />
      <span className="engine__text">{model.text}</span>
      <span className="engine__sub">{model.sub}</span>
    </div>
  );
});

/* ───────────── stats ───────────── */

function StatRow() {
  const stats = useStore((s) => s.stats);
  return (
    <dl className="stats">
      <Stat value={stats?.chainsScanning ?? null} of={stats?.chainsTotal ?? null} label="Chains scanning" title="Chains whose last scan succeeded in the last 2 minutes" />
      <Stat value={stats?.tokensAnalyzed24h ?? null} label="Tokens analyzed" title="24H · distinct tokens analyzed in the last 24 hours" />
      <Stat value={stats?.anomalies24h ?? null} label="Anomalies detected" title="24H · detection events of any severity in the last 24 hours" />
      <Stat value={stats?.breaking24h ?? null} label="Breaking events" title="24H · BREAKING events in the last 24 hours" breaking />
    </dl>
  );
}

const Stat = memo(function Stat(props: { value: number | null; of?: number | null; label: string; title: string; breaking?: boolean }) {
  const { value, of, label, title, breaking } = props;
  return (
    <div className="stat" title={title} data-breaking={breaking && value ? '' : undefined}>
      <dt className="stat__label">{label}</dt>
      <dd className="stat__value">
        {value === null ? <span className="muted">—</span> : <NumberFlow value={value} locales="en-US" />}
        {of != null && value !== null && <span className="stat__of">/{of}</span>}
      </dd>
    </div>
  );
});

/* ───────────── clock ───────────── */

function Clock() {
  const now = useClock();
  return (
    <time className="clock" dateTime={new Date(now).toISOString()} aria-label="Current UTC time">
      {fmtClock(now)} <span className="clock__tz">UTC</span>
    </time>
  );
}
