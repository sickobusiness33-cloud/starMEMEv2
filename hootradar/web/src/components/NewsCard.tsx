import { memo, useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { NewsArticle } from '@shared/types';
import { QUANT_DISCLAIMER } from '@shared/types';
import { isEntering, useStore, type EnterInfo } from '../store';
import { fmtNum, fmtPct, fmtUsd, fmtWindow } from '../lib/format';
import { BuySellBar, EngineBadge, QuantMeter, SeverityTag, TimeAgo, useChainMeta } from './bits';
import { ArticleDetail } from './ArticleDetail';

interface Props {
  article: NewsArticle;
  /** set when the card was inserted live (or on the first render of the feed) */
  enter?: EnterInfo;
}

/**
 * One story. Collapsed: severity · ticker · metrics · quant · AI line.
 * Click / Enter expands the full article inline (grid-template-rows 0fr → 1fr).
 */
export const NewsCard = memo(function NewsCard({ article: a, enter }: Props) {
  const expanded = useStore((s) => s.expanded[a.id] === true);
  const toggle = useStore((s) => s.toggleExpanded);
  const setExpanded = useStore((s) => s.setExpanded);
  const chain = useChainMeta(a.chain);

  // Decide once, at mount, whether this card plays its entrance. A card that
  // Virtuoso re-mounts while scrolling is not "new" and must not animate.
  const [entering, setEntering] = useState(() => isEntering(enter, Date.now()));
  useEffect(() => {
    if (!entering) return;
    const t = setTimeout(() => setEntering(false), 1_500);
    return () => clearTimeout(t);
  }, [entering]);

  // Detail content mounts on first expand and stays (so collapsing can animate).
  const [detailMounted, setDetailMounted] = useState(expanded);
  useEffect(() => {
    if (expanded) setDetailMounted(true);
  }, [expanded]);

  const m = a.metrics;
  const top = a.quant.top;
  const detailId = `card-${a.id}-detail`;
  const style: CSSProperties | undefined =
    entering && enter?.delay ? ({ ['--enter-delay' as string]: `${enter.delay}ms` } as CSSProperties) : undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && expanded) {
      e.stopPropagation();
      setExpanded(a.id, false);
      document.getElementById(`card-${a.id}-toggle`)?.focus();
    }
  };

  return (
    <article
      id={`card-${a.id}`}
      className="card"
      data-sev={a.severity}
      data-expanded={expanded ? '' : undefined}
      data-enter={entering ? '' : undefined}
      data-glow={entering && enter?.glow ? '' : undefined}
      style={style}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        id={`card-${a.id}-toggle`}
        className="card__toggle"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => toggle(a.id)}
      >
        <span className="sr-only">
          {a.severity}: {a.headline}.
        </span>
        <span className="card__head">
          <span className="card__id">
            <SeverityTag severity={a.severity} />
            {a.updateOf && <span className="tag tag--ghost">Update</span>}
            <span className="card__ticker">${a.symbol}</span>
            <span className="card__name">{a.name}</span>
          </span>
          <span className="card__meta">
            <span className="dot" style={{ ['--dot' as string]: chain.color }} aria-hidden="true" />
            <span className="card__chain">{chain.name}</span>
            <span aria-hidden="true">·</span>
            <TimeAgo ts={a.createdAt} />
          </span>
        </span>

        <span className="card__metrics">
          <Metric label={m.mcIsFdv ? 'FDV' : 'MC'} value={fmtUsd(m.marketCapUsd)} />
          <Metric label={m.volumeWindow ? `VOL ${fmtWindow(m.volumeWindow)}` : 'VOL'} value={fmtUsd(m.volumeUsd)} />
          <Metric label="TX/MIN" value={fmtNum(m.txPerMin)} />
          <span className="metric metric--bs">
            <span className="metric__label">BUY/SELL</span>
            <span className="metric__value">
              {m.buyPct === null || m.sellPct === null ? '—' : `${Math.round(m.buyPct)}/${Math.round(m.sellPct)}`}
            </span>
            <BuySellBar buy={m.buyPct} sell={m.sellPct} />
          </span>
          {m.holdersGrowthPct !== null ? (
            <Metric label="HOLDERS" value={fmtPct(m.holdersGrowthPct, 0)} tone={m.holdersGrowthPct > 0 ? 'pos' : undefined} />
          ) : (
            <Metric label="HOLDERS" value={fmtNum(m.holders)} />
          )}
        </span>

        <span className="card__quant" title={QUANT_DISCLAIMER}>
          <QuantMeter score={top ? top.score : null} />
          <span className="card__quant-score">QUANT MATCH {top ? `${Math.round(top.score)}%` : '—'}</span>
          {top && <span className="card__quant-name">· {top.name}</span>}
        </span>

        <span className="card__ai">
          <EngineBadge engine={a.engine} model={a.model} />
          <span className="card__ai-text">{a.aiLine}</span>
        </span>
      </button>

      <div className="card__detail" id={detailId} role="region" aria-label={`Full article: ${a.headline}`} inert={!expanded}>
        <div className="card__detail-inner">{detailMounted && <ArticleDetail article={a} />}</div>
      </div>
    </article>
  );
});

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'pos' }) {
  return (
    <span className="metric">
      <span className="metric__label">{label}</span>
      <span className={tone ? `metric__value ${tone}` : 'metric__value'}>{value}</span>
    </span>
  );
}
