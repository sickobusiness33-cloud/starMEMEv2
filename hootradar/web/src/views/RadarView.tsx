import { useEffect } from 'react';
import type { RadarReport } from '@shared/types';
import { useRadar, type RadarPhase } from '../lib/radar';
import { useStore } from '../store';
import { useRoute } from '../lib/hash-router';
import { validChainId } from '../lib/chains';
import { useClock } from '../lib/time';
import { fmtMs } from '../lib/format';
import { RadarSearch, RecentSearches, startInvestigation, TapeSuggestions, useRateLimitLeft } from '../components/RadarSearch';
import { STAGE_PLACEHOLDERS, StageStepper } from '../components/StageStepper';
import { Candidates, TokenHeader } from '../components/TokenHeader';
import { MetricsGrid } from '../components/MetricsGrid';
import { BriefPanel, DetectionPanel, QuantPanel } from '../components/RadarPanels';
import { IntelPanel } from '../components/IntelList';
import { IconRefresh } from '../components/Icons';

export function RadarView() {
  useDeepLink();
  const phase = useRadar((s) => s.phase);
  const hasReport = useRadar((s) => s.report !== null);

  return (
    <div className="radar">
      <section className="radar__search" aria-label="Search">
        <RadarSearch />
        <RecentSearches />
      </section>
      {phase === 'idle' && !hasReport ? <RadarIdle /> : <Investigation />}
    </div>
  );
}

/**
 * #/radar?q=…&chain=… runs the investigation it describes, unless it is the one
 * already on screen (switching tabs back to RADAR must not re-run it) or one this
 * session already ran (browser back / forward shows it from memory instead of
 * POSTing again: only an explicit search or Re-run starts a new investigation).
 */
function useDeepLink(): void {
  const route = useRoute();
  useEffect(() => {
    if (route.tab !== 'radar') return;
    const q = (route.params.get('q') ?? '').trim().slice(0, 120);
    if (!q) return;
    const chain = validChainId(route.params.get('chain'));
    const st = useRadar.getState();
    const same = st.query !== null && st.query.toLowerCase() === q.toLowerCase() && st.chain === chain;
    if (same && st.phase !== 'idle') return;
    if (st.resume(q, chain)) return;
    st.run(q, chain);
  }, [route]);
}

/* ───────────── idle: what an investigation does + real suggestions ───────────── */

const HOW: Array<{ label: string; text: string }> = [
  { label: 'Resolve', text: 'Symbols and names through DexScreener search; contract addresses by a direct lookup on every chain whose format matches.' },
  { label: 'On-chain', text: 'Price, liquidity, volume, transactions and derived activity metrics from GeckoTerminal and DexScreener.' },
  { label: 'Holders', text: 'Holder count, top-10 concentration and security flags from the holder data provider.' },
  { label: 'Quant', text: 'How closely current conditions resemble published methodologies. A similarity score, never a forecast.' },
  { label: 'Web intel', text: 'GDELT news, Hacker News, 4chan /biz/ and official project links — every mention dated and classed LIVE, RECENT or OLD.' },
  { label: 'Brief', text: 'A short summary with a bullish / neutral / risk outlook, written by Claude or by the rules engine — always labelled.' },
];

function RadarIdle() {
  return (
    <div className="radar-idle">
      <TapeSuggestions />
      <section className="panel how" aria-labelledby="radar-how">
        <div className="panel__head">
          <h2 className="section-title" id="radar-how">
            Investigation pipeline
          </h2>
          <span className="label">6 stages · live</span>
        </div>
        <ol className="how__list">
          {HOW.map((h, i) => (
            <li key={h.label} className="how__item">
              <span className="how__n mono">{String(i + 1).padStart(2, '0')}</span>
              <span className="how__label">{h.label}</span>
              <p className="how__text">{h.text}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/* ───────────── investigation ───────────── */

function Investigation() {
  const report = useRadar((s) => s.report);
  const phase = useRadar((s) => s.phase);
  const error = useRadar((s) => s.error);
  const query = useRadar((s) => s.query);
  const chain = useRadar((s) => s.chain);
  const skewMs = useRadar((s) => s.skewMs);
  const liveEngine = useStore((s) => s.stats?.engine.ai ?? null);
  const engine = report?.brief?.engine ?? liveEngine;

  const rerun = () => {
    if (query) startInvestigation(query, chain);
  };

  if (!report) {
    if (phase === 'error') return <StartError error={error} onRetry={rerun} />;
    return (
      <div className="inv" aria-busy="true">
        <StatusLine report={null} phase={phase} query={query} skewMs={null} onRerun={rerun} />
        <StageStepper stages={STAGE_PLACEHOLDERS} skewMs={null} engine={engine} />
      </div>
    );
  }

  const final = report.status !== 'running';
  const failed = report.status === 'not_found' || report.status === 'error';
  const webStage = report.stages.find((s) => s.id === 'web');

  return (
    <div className="inv" aria-busy={!final}>
      <StatusLine report={report} phase={phase} query={query} skewMs={skewMs} onRerun={rerun} />
      <StageStepper stages={report.stages} skewMs={skewMs} engine={engine} final={report.status !== 'running'} />

      {phase === 'error' && !final && (
        <p className="inv__warn" role="status">
          Lost the live connection to this investigation — {error ?? 'unknown error'}.{' '}
          <button type="button" className="link" onClick={rerun}>
            Run again
          </button>
        </p>
      )}

      {failed && !report.token && (
        <div className="state" role="alert">
          <span className="state__title">{report.status === 'not_found' ? 'No matching token' : 'Investigation failed'}</span>
          <p className="state__text">{report.error ?? 'The engine could not resolve this query.'}</p>
          <p className="state__text muted">
            Try the full contract address, or pick a chain to narrow the search.
          </p>
        </div>
      )}

      {report.token && (
        <>
          <TokenHeader token={report.token} snapshot={report.snapshot} metrics={report.metrics} />
          <Candidates candidates={report.candidates} token={report.token} />
          <div className="inv__grid">
            <div className="inv__main">
              <div className="inv__metrics">
                <MetricsGrid report={report} />
              </div>
              <div className="inv__brief">
                <BriefPanel report={report} />
              </div>
              <div className="inv__intel">
                <IntelPanel key={report.id} intel={report.intel} stage={webStage} providers={report.providers} />
              </div>
            </div>
            <div className="inv__side">
              <div className="inv__detection">
                <DetectionPanel report={report} />
              </div>
              <div className="inv__quant">
                <QuantPanel report={report} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The investigation could not start. A 429 says when the reader may try again and keeps
 * Retry disabled until then (another POST would only earn another 429).
 */
function StartError({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const limited = useRadar((s) => s.retryUntil !== null);
  const left = useRateLimitLeft();
  return (
    <div className="state">
      {/* the alert holds the static message only; the countdown below ticks silently */}
      <div className="state__alert" role="alert">
        <span className="state__title">{limited ? 'Too many radar searches' : 'Investigation could not start'}</span>
        <p className="state__text">
          {limited ? 'The server limits how many investigations can start per minute.' : (error ?? 'Unknown error.')}
        </p>
      </div>
      {limited && (
        <p className="state__text mono">{left > 0 ? `You can search again in ${left} s.` : 'You can search again now.'}</p>
      )}
      <button type="button" className="btn btn--sm" onClick={onRetry} disabled={left > 0}>
        <IconRefresh size={12} />
        {left > 0 ? `Retry in ${left} s` : 'Retry'}
      </button>
    </div>
  );
}

const STATUS_LABEL: Record<RadarReport['status'], string> = {
  running: 'Investigating',
  done: 'Complete',
  not_found: 'Not found',
  error: 'Failed',
  ambiguous: 'Ambiguous',
};

function StatusLine(props: {
  report: RadarReport | null;
  phase: RadarPhase;
  query: string | null;
  skewMs: number | null;
  onRerun: () => void;
}) {
  const { report, phase, query, skewMs, onRerun } = props;
  const status = report?.status ?? 'running';
  const final = report !== null && status !== 'running';
  return (
    <div className="inv__status" data-status={status}>
      {/* a status region: screen readers hear Investigating → Complete / Failed once each,
          not the ticking elapsed time beside it */}
      <span className="inv__state" role="status">
        <span className="inv__dot" aria-hidden="true" />
        {report ? STATUS_LABEL[status] : phase === 'starting' ? 'Starting' : 'Investigating'}
      </span>
      {query && <span className="inv__query mono truncate">“{query}”</span>}
      <span className="inv__time mono">
        {final ? fmtMs(report.updatedAt - report.createdAt) : report ? <Elapsed since={report.createdAt} skewMs={skewMs} /> : null}
      </span>
      {final && (
        <button type="button" className="btn btn--sm inv__rerun" onClick={onRerun} title="Run this investigation again with fresh data">
          <IconRefresh size={12} />
          Re-run
        </button>
      )}
    </div>
  );
}

function Elapsed({ since, skewMs }: { since: number; skewMs: number | null }) {
  const now = useClock();
  if (skewMs === null) return null;
  return <>{Math.max(0, Math.floor((now - skewMs - since) / 1000))} s</>;
}
