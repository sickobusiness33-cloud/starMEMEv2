import { useStore } from '../store';
import { useClock } from '../lib/time';
import { fmtNum, shortSince } from '../lib/format';
import { STATUS_COLOR } from '../lib/chains';

/** Per chain: status, last scan, tokens seen in 24 h, last error (truncated, full text in title). */
export function ChainsPanel() {
  const chains = useStore((s) => s.stats?.chains);
  const now = useClock();

  return (
    <section className="panel chains" aria-labelledby="chains-title">
      <div className="panel__head">
        <h2 className="section-title" id="chains-title">
          Chains
        </h2>
        <span className="label">Last scan · 24H tokens</span>
      </div>
      {!chains ? (
        <p className="panel__body muted">—</p>
      ) : chains.length === 0 ? (
        <p className="panel__body muted">No chain scanners configured.</p>
      ) : (
        <ul className="chains__list">
          {chains.map((c) => (
            <li key={c.id} className="chains__row">
              <span className="chains__name">
                <span className="dot" style={{ ['--dot' as string]: c.color }} aria-hidden="true" />
                {c.name}
              </span>
              <span className="chains__status" style={{ color: STATUS_COLOR[c.status] }}>
                {c.status}
              </span>
              <span className="chains__since mono">{c.lastScanAt ? `${shortSince(c.lastScanAt, now)} ago` : 'never'}</span>
              <span className="chains__tokens mono">{fmtNum(c.tokensSeen24h)}</span>
              {c.lastError && (
                <span className="chains__error" title={c.lastError}>
                  {c.lastError}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
