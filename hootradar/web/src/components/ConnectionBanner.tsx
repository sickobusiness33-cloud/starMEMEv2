import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { reconnectNow } from '../lib/stream';
import { useClock } from '../lib/time';
import { shortSince } from '../lib/format';

/** A blip shorter than this (phone waking up, a proxy hiccup) never shows the banner. */
const GRACE_MS = 1_200;
/** How long "Live again" stays up after the stream recovers. */
const BACK_MS = 2_400;

type Phase = 'hidden' | 'down' | 'back';

/**
 * Stream health, said plainly. Once the feed has data, a dropped /api/stream
 * means every figure on screen is the last one received — the reader must know.
 * Overlays the top of the content (no layout shift) and confirms recovery.
 */
export function ConnectionBanner() {
  const hydrated = useStore((s) => s.hydrated);
  const conn = useStore((s) => s.conn);
  const down = hydrated && conn !== 'open';
  const [phase, setPhase] = useState<Phase>('hidden');

  useEffect(() => {
    if (down) {
      if (phase === 'down') return;
      const t = setTimeout(() => setPhase('down'), GRACE_MS);
      return () => clearTimeout(t);
    }
    if (phase === 'down') setPhase('back');
  }, [down, phase]);

  useEffect(() => {
    if (phase !== 'back') return;
    const t = setTimeout(() => setPhase('hidden'), BACK_MS);
    return () => clearTimeout(t);
  }, [phase]);

  return (
    <div className="conn-banner" data-phase={phase} role="status" aria-live="polite">
      <div className="conn-banner__inner">
        {phase === 'down' && <DownMessage offline={conn === 'offline'} />}
        {phase === 'back' && (
          <>
            <span className="dot" style={{ ['--dot' as string]: 'var(--green)' }} aria-hidden="true" />
            <span className="conn-banner__title">Live again</span>
            <span className="conn-banner__text">Stream reconnected · figures are current.</span>
          </>
        )}
      </div>
    </div>
  );
}

function DownMessage({ offline }: { offline: boolean }) {
  const retryAt = useStore((s) => s.retryAt);
  return (
    <>
      <span className="dot conn-banner__dot" aria-hidden="true" />
      <span className="conn-banner__title">{offline ? 'Offline' : 'Live stream interrupted'}</span>
      <span className="conn-banner__text">Showing the last figures received.</span>
      <span className="conn-banner__retry">
        {offline ? 'Waiting for the network' : retryAt ? <RetryCountdown at={retryAt} /> : 'Reconnecting…'}
      </span>
      {!offline && (
        <button type="button" className="btn btn--sm conn-banner__btn" onClick={reconnectNow}>
          Retry now
        </button>
      )}
    </>
  );
}

function RetryCountdown({ at }: { at: number }) {
  const now = useClock();
  // under a second left reads as "now", not "Retrying in 0s"
  return <>{at - now >= 1_000 ? `Retrying in ${shortSince(now, at)}` : 'Reconnecting…'}</>;
}
