import { memo, useState } from 'react';
import type { DetectionEvent } from '@shared/types';
import { useStore } from '../store';
import { navigate } from '../lib/hash-router';
import { fmtClock } from '../lib/format';
import { useChainMeta } from './bits';

const MAX_ROWS = 60;
const ENTER_MS = 1_500;

/** Newest detection events, all severities: `14:32:05 ● $TOKEN WATCH 52 Volume 4.1x`. */
export function SignalTape() {
  const events = useStore((s) => s.detections);
  const enter = useStore((s) => s.detectionEnter);
  const hydrated = useStore((s) => s.hydrated);
  const rows = events.length > MAX_ROWS ? events.slice(0, MAX_ROWS) : events;

  return (
    <section className="panel tape" aria-labelledby="tape-title">
      <div className="panel__head">
        <h2 className="section-title" id="tape-title">
          Signal tape
        </h2>
        <span className="label">{hydrated ? `${rows.length} latest · UTC` : ''}</span>
      </div>
      {!hydrated ? (
        <div className="tape__list" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="tape__skel">
              <span className="skel" style={{ width: 52, height: 9 }} />
              <span className="skel" style={{ width: `${40 + ((i * 17) % 35)}%`, height: 9 }} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="panel__body muted">No detections yet. WATCH, ALERT and BREAKING events stream here as the scanners find them.</p>
      ) : (
        <ol className="tape__list">
          {rows.map((e) => (
            <TapeRow key={e.id} event={e} enteredAt={enter[e.id]} />
          ))}
        </ol>
      )}
    </section>
  );
}

const TapeRow = memo(function TapeRow({ event: e, enteredAt }: { event: DetectionEvent; enteredAt: number | undefined }) {
  const chain = useChainMeta(e.chain);
  const [entering] = useState(() => enteredAt !== undefined && Date.now() - enteredAt < ENTER_MS);
  const top = e.signals.length ? e.signals.reduce((a, b) => (b.weight > a.weight ? b : a)) : null;
  const open = () => {
    if (e.articleId) {
      navigate('live');
      void useStore.getState().focusArticle(e.articleId);
    } else {
      navigate('radar', { q: e.address, chain: e.chain });
    }
  };
  return (
    <li className="tape__item" data-enter={entering ? '' : undefined}>
      <button
        type="button"
        className="tape__row"
        data-sev={e.severity}
        onClick={open}
        title={`${e.name} on ${chain.name} — ${e.articleId ? 'open the article' : 'investigate in Radar'}`}
      >
        <time className="tape__time" dateTime={new Date(e.ts).toISOString()}>
          {fmtClock(e.ts)}
        </time>
        <span className="dot" style={{ ['--dot' as string]: chain.color }} aria-hidden="true" />
        <span className="tape__sym">${e.symbol}</span>
        <span className="tape__sev">
          {e.severity} <span className="tape__score">{e.score}</span>
        </span>
        <span className="tape__sig">{top?.label ?? ''}</span>
      </button>
    </li>
  );
});
