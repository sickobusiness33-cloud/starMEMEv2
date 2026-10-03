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

interface PillModel {
  state: PillState;
  /** desktop label (with the sub-label beside it, ≥ 1200px) */
  text: string;
  /** narrow label: the sub-label is hidden there, so this one must say AI vs rules on its own */
  short: string;
  sub: string;
  /** amber sub-label: Claude is configured but its last call failed (stories fall back to rules) */
  warn: boolean;
  title: string;
}

/**
 * Never claims AI when it is not: the rules engine is "ENGINE ACTIVE" + "RULES ENGINE";
 * Claude is "AI ENGINE ACTIVE" + "CLAUDE · model"; a failing Claude says so in amber.
 */
function pillModel(stats: Stats | null, conn: ConnState, retryAt: number | null, now: number): PillModel {
  if (conn === 'offline') {
    return { state: 'offline', text: 'OFFLINE', short: 'OFFLINE', sub: 'NO NETWORK', warn: false, title: 'Your device is offline.' };
  }
  if (!stats || conn !== 'open') {
    const retry = retryAt && retryAt > now ? ` · RETRY ${shortSince(now, retryAt)}` : '';
    const text = stats ? 'RECONNECTING' : 'CONNECTING';
    return {
      state: 'offline',
      text,
      short: text,
      sub: `STREAM${retry}`,
      warn: false,
      title: stats ? 'Live stream interrupted — numbers below are the last values received.' : 'Connecting to the engine…',
    };
  }
  const { engine } = stats;
  const claude = engine.ai === 'claude';
  const model = engine.model ?? 'model unknown';
  const aiFailing = claude && engine.aiError !== null && engine.aiError !== '';
  const sub = aiFailing ? 'AI ERROR · FALLBACK RULES' : claude ? `CLAUDE · ${model}` : 'RULES ENGINE';
  const writer = aiFailing
    ? `Claude (${model}) is configured but its last call failed: ${engine.aiError}. Stories fall back to the deterministic rules engine until it recovers.`
    : claude
      ? `News written by Claude (${model}).`
      : 'News written by the deterministic rules engine (no AI key configured).';

  if (engine.status === 'starting') {
    return { state: 'booting', text: 'BOOTING', short: 'BOOTING', sub, warn: aiFailing, title: `Engine starting. ${writer}` };
  }
  if (engine.status === 'degraded') {
    return {
      state: 'degraded',
      text: 'DEGRADED',
      short: claude ? 'AI DEGRADED' : 'RULES DEGRADED',
      sub,
      warn: aiFailing,
      title: `Engine degraded: no chain is scanning successfully right now. ${writer}`,
    };
  }
  return {
    state: 'active',
    text: claude ? 'AI ENGINE ACTIVE' : 'ENGINE ACTIVE',
    short: aiFailing ? 'AI ERROR' : claude ? 'AI ACTIVE' : 'RULES ACTIVE',
    sub,
    warn: aiFailing,
    title: writer,
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

const EnginePillView = memo(function EnginePillView({ model }: { model: PillModel }) {
  return (
    <div className="engine" data-state={model.state} data-warn={model.warn ? '' : undefined} title={model.title}>
      <span className="engine__dot" aria-hidden="true" />
      <span className="engine__text">
        <span className="engine__full">{model.text}</span>
        <span className="engine__short" aria-hidden="true">
          {model.short}
        </span>
      </span>
      <span className="engine__sub">{model.sub}</span>
    </div>
  );
});

/* ───────────── stats ───────────── */

function StatRow() {
  const stats = useStore((s) => s.stats);
  return (
    <dl className="stats">
      <Stat
        value={stats?.chainsScanning ?? null}
        of={stats?.chainsTotal ?? null}
        label="Chains scanning"
        short="Chains"
        title="Chains whose last scan succeeded in the last 2 minutes"
      />
      <Stat
        value={stats?.tokensAnalyzed24h ?? null}
        label="Tokens analyzed"
        short="Tokens 24H"
        title="24H · distinct tokens analyzed in the last 24 hours"
      />
      <Stat
        value={stats?.anomalies24h ?? null}
        label="Anomalies detected"
        short="Anomalies"
        title="24H · detection events of any severity in the last 24 hours"
      />
      <Stat
        value={stats?.breaking24h ?? null}
        label="Breaking events"
        short="Breaking"
        title="24H · BREAKING events in the last 24 hours"
        breaking
      />
    </dl>
  );
}

/**
 * Counter roll timing. Stats arrive every 5 s all day, in peripheral vision: the library's
 * 900 ms default is three times the UI budget. State indication, so it moves — briefly.
 * Module constants so the memoized Stat never sees new props. Reduced motion is honoured by
 * NumberFlow itself (respectMotionPreference).
 */
const ROLL = { duration: 300, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' } as const;
const FADE = { duration: 150, easing: 'ease-out' } as const;

const Stat = memo(function Stat(props: {
  value: number | null;
  of?: number | null;
  label: string;
  /** narrow-layout label; the full label stays available to screen readers */
  short: string;
  title: string;
  breaking?: boolean;
}) {
  const { value, of, label, short, title, breaking } = props;
  return (
    <div className="stat" title={title} data-breaking={breaking && value ? '' : undefined}>
      <dt className="stat__label">
        <span className="stat__full">{label}</span>
        <span className="stat__short" aria-hidden="true">
          {short}
        </span>
      </dt>
      <dd className="stat__value">
        {value === null ? (
          <span className="muted">—</span>
        ) : (
          <NumberFlow value={value} locales="en-US" transformTiming={ROLL} spinTiming={ROLL} opacityTiming={FADE} />
        )}
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
