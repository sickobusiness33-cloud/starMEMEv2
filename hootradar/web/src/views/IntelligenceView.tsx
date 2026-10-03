import { memo, useId, useMemo, useState } from 'react';
import type { MarketRegime, QuantLeader, QuantMethodology, QuantReference } from '@shared/types';
import { QUANT_DISCLAIMER } from '@shared/types';
import { LEADERS_REFRESH_MS, useQuant, useQuantPolling } from '../lib/quant';
import { fmtClock, fmtPct, fmtTicker, fmtUsd, hostOf, safeUrl } from '../lib/format';
import { familyLabel, TimeAgo, useChainMeta } from '../components/bits';
import { startInvestigation } from '../components/RadarSearch';
import { IconBook, IconChevron, IconExternal, IconPaper, IconRefresh } from '../components/Icons';

export function IntelligenceView() {
  useQuantPolling();
  const library = useQuant((s) => s.library);
  const leaders = useQuant((s) => s.leaders);
  const loadLibrary = useQuant((s) => s.loadLibrary);

  const byMethod = useMemo(() => {
    const map = new Map<string, QuantLeader['tokens']>();
    for (const l of leaders.data?.leaders ?? []) map.set(l.methodologyId, l.tokens);
    return map;
  }, [leaders.data]);

  const methods = library.data?.methodologies ?? [];

  return (
    <div className="intel-view">
      <RegimeBanner />

      <section aria-labelledby="lib-title" className="lib">
        <header className="lib__head">
          <h2 className="section-title" id="lib-title">
            Methodology library
            {methods.length > 0 && <span className="muted mono">{methods.length}</span>}
          </h2>
          <LeadersStamp />
        </header>

        {library.status === 'error' && !library.data ? (
          <div className="state" role="alert">
            <span className="state__title">Library unavailable</span>
            <p className="state__text">{library.error}</p>
            <button type="button" className="btn btn--sm" onClick={() => loadLibrary(true)}>
              <IconRefresh size={12} />
              Retry
            </button>
          </div>
        ) : !library.data ? (
          <div className="lib__grid" role="status" aria-label="Loading the methodology library">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="mcard mcard--skel" aria-hidden="true">
                <span className="skel" style={{ width: '58%', height: 14 }} />
                <span className="skel" style={{ width: '94%', height: 10 }} />
                <span className="skel" style={{ width: '86%', height: 10 }} />
                <span className="skel" style={{ width: '40%', height: 10 }} />
              </div>
            ))}
          </div>
        ) : (
          <ul className="lib__grid">
            {methods.map((m) => (
              <li key={m.id}>
                <MethodologyCard
                  method={m}
                  leaders={byMethod.get(m.id) ?? null}
                  leadersState={leaders.data ? 'ready' : leaders.status === 'error' ? 'error' : 'loading'}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="intel-foot">
        <section aria-labelledby="disclaimer-title">
          <h2 className="section-title" id="disclaimer-title">
            Disclaimer
          </h2>
          <p>{library.data?.disclaimer ?? QUANT_DISCLAIMER}</p>
        </section>
        <section aria-labelledby="policy-title">
          <h2 className="section-title" id="policy-title">
            Source policy
          </h2>
          <p>{library.data?.sourcePolicy ?? '—'}</p>
        </section>
      </footer>
    </div>
  );
}

/* ───────────── regime banner ───────────── */

const REGIME_TEXT: Record<MarketRegime['label'], string> = {
  'risk-on': 'Risk-on',
  neutral: 'Neutral',
  'risk-off': 'Risk-off',
  unknown: 'Unknown',
};

function RegimeBanner() {
  const leaders = useQuant((s) => s.leaders);
  const r = leaders.data?.regime ?? null;

  return (
    <section className="regime" data-regime={r?.label ?? 'loading'} aria-labelledby="regime-title">
      <div className="regime__main">
        <h2 className="label" id="regime-title">
          Market regime
        </h2>
        <p className="regime__label">
          <span className="regime__dot" aria-hidden="true" />
          {r ? REGIME_TEXT[r.label] : leaders.status === 'error' ? 'Unavailable' : <span className="skel" style={{ width: 120, height: 20 }} />}
        </p>
        <p className="regime__note">
          {r
            ? r.label === 'unknown'
              ? `Too few tokens to classify (${r.sampleSize}): it needs young tokens at least 45 min old, with $5K+ liquidity, observed in the last hour.`
              : 'Breadth and median 1H move of the young tokens the scanners observed in the last hour (at least 45 min old, $5K+ liquidity).'
            : leaders.status === 'error'
              ? (leaders.error ?? 'Could not load the market regime.')
              : 'Computing from the tracked universe…'}
        </p>
      </div>
      <dl className="regime__stats">
        <div className="regime__stat">
          <dt className="label">Breadth</dt>
          <dd className="regime__value mono">{r ? fmtPct(r.breadthPct, 0, { sign: false }) : '—'}</dd>
          <dd className="regime__sub">tokens up over 1H</dd>
        </div>
        <div className="regime__stat">
          <dt className="label">Median 1H</dt>
          <dd className="regime__value mono">{r ? fmtPct(r.medianH1ChangePct) : '—'}</dd>
          <dd className="regime__sub">price change</dd>
        </div>
        <div className="regime__stat">
          <dt className="label">Sample</dt>
          <dd className="regime__value mono">{r ? r.sampleSize.toLocaleString('en-US') : '—'}</dd>
          <dd className="regime__sub">young tokens</dd>
        </div>
        <div className="regime__stat">
          <dt className="label">Computed</dt>
          <dd className="regime__value mono">{r ? `${fmtClock(r.computedAt)}` : '—'}</dd>
          <dd className="regime__sub">{r ? <TimeAgo ts={r.computedAt} /> : 'UTC'}</dd>
        </div>
      </dl>
    </section>
  );
}

function LeadersStamp() {
  const leaders = useQuant((s) => s.leaders);
  const loadLeaders = useQuant((s) => s.loadLeaders);
  const refreshing = leaders.status === 'loading';
  return (
    <div className="lib__stamp">
      <span className="label">
        Live leaders · every {LEADERS_REFRESH_MS / 1000} s
        {leaders.data && (
          <>
            {' '}
            · <TimeAgo ts={leaders.data.computedAt} />
          </>
        )}
        {leaders.error && leaders.data && <span className="risk"> · last refresh failed</span>}
      </span>
      <button
        type="button"
        className="btn btn--sm btn--ghost btn--icon"
        onClick={loadLeaders}
        disabled={refreshing}
        aria-label="Refresh live leaders"
        title="Refresh live leaders"
        data-spinning={refreshing ? '' : undefined}
      >
        <IconRefresh size={12} />
      </button>
    </div>
  );
}

/* ───────────── methodology card ───────────── */

const REF_KIND: Record<QuantReference['kind'], string> = {
  paper: 'Paper',
  quantpedia: 'Quantpedia',
  book: 'Book',
  article: 'Article',
};

const MethodologyCard = memo(function MethodologyCard(props: {
  method: QuantMethodology;
  leaders: QuantLeader['tokens'] | null;
  leadersState: 'ready' | 'loading' | 'error';
}) {
  const { method: m, leaders, leadersState } = props;
  const [open, setOpen] = useState(false);
  const extraId = useId();

  return (
    <article className="mcard" data-open={open ? '' : undefined} aria-labelledby={`${extraId}-name`}>
      <header className="mcard__head">
        <h3 className="mcard__name" id={`${extraId}-name`}>
          {m.name}
        </h3>
        <span className="tag tag--ghost">{familyLabel(m.family)}</span>
      </header>
      <p className="mcard__summary">{m.summary}</p>

      <dl className="mcard__facts">
        <div>
          <dt className="label">Looks for</dt>
          <dd>{m.signature}</dd>
        </div>
        <div className="mcard__horizon">
          <dt className="label">Horizon</dt>
          <dd className="mono">{m.horizon}</dd>
        </div>
      </dl>

      {/* inline on wide screens; folded into the accordion on phones, where 11 full cards would be a 9,000 px scroll */}
      {m.caveats.length > 0 && <Caveats items={m.caveats} className="mcard__caveats--inline" />}

      {(m.cryptoAdaptation || m.howItWorks.length > 0 || m.caveats.length > 0) && (
        <div className="mcard__how">
          <button
            type="button"
            className="mcard__toggle"
            aria-expanded={open}
            aria-controls={`${extraId}-how`}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="mcard__toggle-wide">Method details</span>
            <span className="mcard__toggle-phone">{m.caveats.length > 0 ? 'Caveats & method' : 'Method details'}</span>
            <IconChevron size={12} className="mcard__chev" />
          </button>
          <div className="mcard__extra" id={`${extraId}-how`} inert={!open}>
            <div className="mcard__extra-inner">
              {m.caveats.length > 0 && <Caveats items={m.caveats} className="mcard__caveats--fold" />}
              <dl className="mcard__facts mcard__facts--extra">
                {m.cryptoAdaptation && (
                  <div>
                    <dt className="label">Crypto adaptation</dt>
                    <dd>{m.cryptoAdaptation}</dd>
                  </div>
                )}
                {m.howItWorks.length > 0 && (
                  <div>
                    <dt className="label">How it works</dt>
                    <dd>
                      <ul className="bullets">
                        {m.howItWorks.map((h, i) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
        </div>
      )}

      {m.references.length > 0 && (
        <ul className="refs" aria-label="References">
          {m.references.map((r) => {
            const url = safeUrl(r.url);
            const Icon = r.kind === 'quantpedia' || r.kind === 'book' ? IconBook : IconPaper;
            return (
              <li key={r.url}>
                {url ? (
                  <a className="ref" href={url} target="_blank" rel="noopener noreferrer" title={`${r.label} — ${hostOf(url)}`}>
                    <Icon size={12} />
                    <span className="ref__label">{r.label}</span>
                    <span className="ref__kind">{REF_KIND[r.kind]}</span>
                    <IconExternal size={10} className="ref__ext" />
                  </a>
                ) : (
                  <span className="ref">
                    <Icon size={12} />
                    <span className="ref__label">{r.label}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Leaders tokens={leaders} state={leadersState} methodName={m.name} />
    </article>
  );
});

function Caveats({ items, className }: { items: string[]; className: string }) {
  return (
    <div className={`mcard__caveats ${className}`}>
      <span className="label">Caveats</span>
      <ul className="bullets">
        {items.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

function Leaders({ tokens, state, methodName }: { tokens: QuantLeader['tokens'] | null; state: 'ready' | 'loading' | 'error'; methodName: string }) {
  return (
    <div className="leaders" role="group" aria-label={`Live leaders for ${methodName}`}>
      <div className="leaders__head">
        <span className="label leaders__title">
          <span className="dot" style={{ ['--dot' as string]: 'var(--green)' }} aria-hidden="true" />
          Live leaders
        </span>
        <span className="label">Similarity</span>
      </div>
      {state === 'loading' && !tokens ? (
        <div className="leaders__list" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="leader leader--skel" aria-hidden="true">
              <span className="skel" style={{ width: 54, height: 10 }} />
              <span className="skel" style={{ width: '100%', height: 4 }} />
            </div>
          ))}
        </div>
      ) : state === 'error' && !tokens ? (
        <p className="leaders__empty">Leaders unavailable right now.</p>
      ) : !tokens || tokens.length === 0 ? (
        <p className="leaders__empty">No tracked token resembles this method right now.</p>
      ) : (
        <ol className="leaders__list">
          {tokens.map((t) => (
            <li key={`${t.chain}:${t.address}`}>
              <LeaderRow token={t} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function LeaderRow({ token: t }: { token: QuantLeader['tokens'][number] }) {
  const chain = useChainMeta(t.chain);
  const score = Math.max(0, Math.min(100, t.score));
  return (
    <button
      type="button"
      className="leader"
      onClick={() => startInvestigation(t.address, t.chain)}
      title={`${t.name} on ${chain.name} · liquidity ${fmtUsd(t.liquidityUsd)} — investigate in Radar`}
    >
      <span className="leader__id">
        <span className="dot" style={{ ['--dot' as string]: chain.color }} aria-hidden="true" />
        <span className="leader__sym">{fmtTicker(t.symbol)}</span>
        <span className="leader__chain">{chain.short}</span>
      </span>
      <span className="bar leader__bar" aria-hidden="true">
        <i className="bar__fill" style={{ transform: `scaleX(${score / 100})` }} />
      </span>
      <span className="leader__score mono">{Math.round(score)}</span>
    </button>
  );
}
