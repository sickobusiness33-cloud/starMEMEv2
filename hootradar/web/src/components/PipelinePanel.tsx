import { useStore } from '../store';
import { fmtClock, fmtMs } from '../lib/format';
import { pipelineSteps } from './ArticleDetail';
import { TimeAgo } from './bits';

/** Real stage timings of the most recent article: DETECT → ANALYZE → QUANT → WRITE → PUBLISH. */
export function PipelinePanel() {
  const latest = useStore((s) => {
    const a = s.articles[0];
    const b = s.buffered[0];
    if (a && b) return a.createdAt >= b.createdAt ? a : b;
    return a ?? b ?? null;
  });
  const hydrated = useStore((s) => s.hydrated);

  return (
    <section className="panel pipe" aria-labelledby="pipe-title">
      <div className="panel__head">
        <h2 className="section-title" id="pipe-title">
          Pipeline
        </h2>
        {latest && (
          <span className="label pipe__which">
            ${latest.symbol} · <TimeAgo ts={latest.createdAt} />
          </span>
        )}
      </div>
      {!latest ? (
        <p className="panel__body muted">{hydrated ? 'No article published yet. Timings appear with the first story.' : '—'}</p>
      ) : (
        <PipelineRows pipeline={latest.pipeline} />
      )}
    </section>
  );
}

function PipelineRows({ pipeline }: { pipeline: Parameters<typeof pipelineSteps>[0] }) {
  const steps = pipelineSteps(pipeline);
  const total = Math.max(1, pipeline.publishedAt - pipeline.detectedAt);
  return (
    <ol className="pipe__rows">
      {steps.map((s) => (
        <li key={s.id} className="pipe__row">
          <span className="pipe__label">{s.label}</span>
          <span className="bar pipe__bar" aria-hidden="true">
            {s.delta !== null && (
              <i className="bar__fill" style={{ transform: `scaleX(${Math.max(0.015, Math.min(1, s.delta / total))})` }} />
            )}
          </span>
          <span className="pipe__value mono">{s.delta === null ? fmtClock(s.at) : `+${fmtMs(s.delta)}`}</span>
        </li>
      ))}
      <li className="pipe__row pipe__row--total">
        <span className="pipe__label">Total</span>
        <span />
        <span className="pipe__value mono">{fmtMs(pipeline.publishedAt - pipeline.detectedAt)}</span>
      </li>
    </ol>
  );
}
