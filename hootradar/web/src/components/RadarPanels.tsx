import type { RadarReport, RadarStage, RadarStageId } from '@shared/types';
import { QUANT_DISCLAIMER } from '@shared/types';
import { useStore } from '../store';
import { CapChips, capsOf, EngineBadge, EngineLine, MatchBars, OutlookTrio, RegimeTag, SeverityBands } from './bits';

function stageOf(r: RadarReport, id: RadarStageId): RadarStage | undefined {
  return r.stages.find((s) => s.id === id);
}

const isBusy = (s: RadarStage | undefined) => !s || s.status === 'pending' || s.status === 'running';

/** What a finished stage said when it produced nothing (skipped / error), so an empty panel is explained. */
function stageNote(s: RadarStage | undefined, fallback: string): string {
  if (!s) return fallback;
  if (s.status === 'error') return `Stage failed: ${s.message ?? 'unknown error'}`;
  return s.message ?? fallback;
}

function SkeletonLines({ lines, label }: { lines: number[]; label: string }) {
  return (
    <div className="skel-lines" role="status" aria-label={label}>
      {lines.map((w, i) => (
        <span key={i} className="skel" style={{ width: `${w}%`, height: 10 }} />
      ))}
    </div>
  );
}

/* ───────────── detection ───────────── */

export function DetectionPanel({ report }: { report: RadarReport }) {
  const d = report.detection;
  const busy = isBusy(stageOf(report, 'onchain')) || isBusy(stageOf(report, 'holders'));
  const signals = d ? [...d.signals].sort((a, b) => b.weight - a.weight) : [];
  const caps = capsOf(d);
  // a rejected token has no severity whatever its score (e.g. 67 but older than 7 days): say why, not "below watch"
  const level = d ? (d.severity ?? (d.rejected.length > 0 ? 'Not eligible' : 'Below watch')) : null;

  return (
    <section className="panel rpanel" aria-labelledby="radar-detection">
      <div className="panel__head">
        <h3 className="section-title" id="radar-detection">
          Detection
        </h3>
        {d && busy && <span className="label">Provisional</span>}
      </div>
      <div className="panel__body det">
        {!d ? (
          busy ? (
            <SkeletonLines lines={[38, 92, 74]} label="Scoring" />
          ) : (
            <p className="muted">{stageNote(stageOf(report, 'onchain'), 'No on-chain metrics to score.')}</p>
          )
        ) : (
          <>
            <div className="det__sev" data-sev={d.severity ?? 'NONE'} title={d.severity === null ? d.rejected.join(' · ') || undefined : undefined}>
              <span className="det__level">{level}</span>
              <span className="det__score mono">score {Math.round(d.score)}</span>
            </div>
            <SeverityBands score={d.score} severity={d.severity} capped={caps.length > 0} />
            <CapChips caps={caps} severity={d.severity} />
            {signals.length > 0 ? (
              <ul className="sig-chips" aria-label="Anomaly signals">
                {signals.map((s) => (
                  <li
                    key={s.code}
                    className="sig-chip"
                    data-zero={Math.round(s.weight) === 0 ? '' : undefined}
                    title={Math.round(s.weight) === 0 ? 'Observed, but adds nothing to the score yet' : undefined}
                  >
                    <span>{s.label}</span>
                    <span className="sig-chip__w mono">+{Math.round(s.weight)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No anomaly signals in the current data.</p>
            )}
            {d.rejected.length > 0 && (
              <div className="det__rejected">
                <span className="label">Not eligible for the newsroom</span>
                <ul className="bullets">
                  {d.rejected.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/* ───────────── quant ───────────── */

export function QuantPanel({ report }: { report: RadarReport }) {
  const q = report.quant;
  const stage = stageOf(report, 'quant');
  return (
    <section className="panel rpanel" aria-labelledby="radar-quant">
      <div className="panel__head">
        <h3 className="section-title" id="radar-quant">
          Quant match
        </h3>
        {q && <RegimeTag regime={q.regime} />}
      </div>
      <div className="panel__body rquant">
        {!q ? (
          isBusy(stage) ? (
            <SkeletonLines lines={[64, 100, 48, 100]} label="Matching methodologies" />
          ) : (
            <p className="muted">{stageNote(stage, 'Quant analysis unavailable.')}</p>
          )
        ) : (
          <>
            <MatchBars matches={q.matches.slice(0, 4)} />
            <div className="rquant__flags">
              <span className="label">Risk flags</span>
              {q.riskFlags.length === 0 ? (
                <p className="muted">No risk flags raised by the data we have.</p>
              ) : (
                <ul className="flags">
                  {q.riskFlags.map((f) => (
                    <li key={f} className="tag tag--risk">
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="disclaimer">{q.disclaimer || QUANT_DISCLAIMER}</p>
          </>
        )}
      </div>
    </section>
  );
}

/* ───────────── AI brief ───────────── */

export function BriefPanel({ report }: { report: RadarReport }) {
  const b = report.brief;
  const stage = stageOf(report, 'ai');
  // Never claim AI when the rules engine wrote it: before the brief lands, the live engine decides the title.
  const liveEngine = useStore((s) => s.stats?.engine.ai ?? null);
  const engine = b?.engine ?? liveEngine;
  return (
    <section className="panel rpanel brief" aria-labelledby="radar-brief" aria-busy={isBusy(stage) && !b}>
      <div className="panel__head">
        <h3 className="section-title" id="radar-brief">
          {engine === 'claude' ? 'AI brief' : 'Brief'}
        </h3>
        {b && <EngineBadge engine={b.engine} model={b.model} />}
      </div>
      <div className="panel__body brief__body">
        {!b ? (
          isBusy(stage) ? (
            <>
              <SkeletonLines lines={[96, 88, 70]} label="Writing the brief" />
              <p className="label brief__wait">
                {stage?.status === 'running' ? 'Writing…' : 'Written once web intel is in'}
              </p>
            </>
          ) : (
            <p className="muted">{stageNote(stage, 'No brief for this investigation.')}</p>
          )
        ) : (
          <>
            <p className="brief__summary">{b.summary}</p>
            {b.bullets.length > 0 && (
              <ul className="bullets">
                {b.bullets.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            )}
            <OutlookTrio outlook={b.outlook} />
            {/* the header badge already says RULES; the model name is the extra fact worth a footer */}
            {b.engine === 'claude' && (
              <div className="brief__foot">
                <EngineLine engine={b.engine} model={b.model} />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
