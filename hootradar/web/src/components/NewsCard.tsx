import { memo, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { NewsArticle } from '@shared/types';
import { QUANT_DISCLAIMER } from '@shared/types';
import { isEntering, useStore, type EnterInfo } from '../store';
import { fmtNum, fmtPct, fmtSplit, fmtTicker, fmtUsd, fmtWindow } from '../lib/format';
import { BuySellBar, EngineBadge, QuantMeter, SeverityTag, TimeAgo, useChainMeta } from './bits';
import { ArticleDetail } from './ArticleDetail';

interface Props {
  article: NewsArticle;
  /** set when the card was inserted live (or on the first render of the feed) */
  enter?: EnterInfo;
}

/** a pointer that travels further than this between down and up is selecting text, not pressing */
const PRESS_SLOP_PX = 6;

/**
 * One story. Collapsed: severity · ticker · metrics · quant · AI line.
 * Click / Enter expands the full article inline (grid-template-rows 0fr → 1fr).
 *
 * The toggle is a real <button> named only "SEVERITY: headline" (described by the AI line),
 * stretched under the summary. The summary itself is content, not a control label: the
 * ticker, figures and AI line stay selectable and copyable, and a plain click on them
 * toggles too (a drag that selects text does not).
 */
export const NewsCard = memo(function NewsCard({ article: a, enter }: Props) {
  const expanded = useStore((s) => s.expanded[a.id] === true);
  const toggle = useStore((s) => s.toggleExpanded);
  const setExpanded = useStore((s) => s.setExpanded);
  const chain = useChainMeta(a.chain);
  const cardRef = useRef<HTMLElement>(null);
  const press = useRef<{ x: number; y: number } | null>(null);

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
  const aiId = `card-${a.id}-ai`;
  const style: CSSProperties | undefined =
    entering && enter?.delay ? ({ ['--enter-delay' as string]: `${enter.delay}ms` } as CSSProperties) : undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && expanded) {
      e.stopPropagation();
      setExpanded(a.id, false);
      document.getElementById(`card-${a.id}-toggle`)?.focus();
    }
  };

  // Press feedback for the summary, set on the element directly (no re-render). Cleared as soon
  // as the pointer travels: a drag is a text selection and the card must hold still under it.
  const setPressed = (on: boolean) => {
    const el = cardRef.current;
    if (!el) return;
    if (on) el.dataset.pressed = '';
    else delete el.dataset.pressed;
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || expanded) return;
    press.current = { x: e.clientX, y: e.clientY };
    setPressed(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP_PX) {
      press.current = null;
      setPressed(false);
    }
  };
  const endPress = () => {
    press.current = null;
    setPressed(false);
  };

  const onSummaryClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest('.card__toggle')) return; // the button handles itself
    if (e.detail > 1) return; // double / triple click selects a word or line: keep the first click's result
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return; // selecting text
    toggle(a.id);
  };

  return (
    <article
      ref={cardRef}
      id={`card-${a.id}`}
      className="card"
      data-sev={a.severity}
      data-expanded={expanded ? '' : undefined}
      data-enter={entering ? '' : undefined}
      data-glow={entering && enter?.glow ? '' : undefined}
      style={style}
      onKeyDown={onKeyDown}
    >
      <div
        className="card__summary"
        onClick={onSummaryClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onPointerLeave={endPress}
      >
        <button
          type="button"
          id={`card-${a.id}-toggle`}
          className="card__toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-describedby={aiId}
          onClick={() => toggle(a.id)}
        >
          <span className="sr-only">
            {a.severity}: {a.headline}
          </span>
        </button>

        <div className="card__head">
          <div className="card__id">
            <SeverityTag severity={a.severity} />
            {a.updateOf && <span className="tag tag--ghost">Update</span>}
            <span className="card__ticker">{fmtTicker(a.symbol)}</span>
            <span className="card__name">{a.name}</span>
          </div>
          <div className="card__meta">
            <span className="dot" style={{ ['--dot' as string]: chain.color }} aria-hidden="true" />
            <span className="card__chain">
              <span className="card__chain-full">{chain.name}</span>
              <span className="card__chain-short" aria-hidden="true">
                {chain.short}
              </span>
            </span>
            <span aria-hidden="true">·</span>
            <TimeAgo ts={a.createdAt} compact />
          </div>
        </div>

        <div className="card__metrics">
          <Metric label={m.mcIsFdv ? 'FDV' : 'MC'} value={fmtUsd(m.marketCapUsd)} />
          <Metric label={m.volumeWindow ? `VOL ${fmtWindow(m.volumeWindow)}` : 'VOL'} value={fmtUsd(m.volumeUsd)} />
          <Metric label="TX/MIN" value={fmtNum(m.txPerMin)} />
          <span className="metric metric--bs">
            <span className="metric__label">BUY/SELL</span>
            <span className="metric__value">{fmtSplit(m.buyPct, m.sellPct) ?? '—'}</span>
            <BuySellBar buy={m.buyPct} sell={m.sellPct} />
          </span>
          {m.holdersGrowthPct !== null ? (
            <Metric label="HOLDERS" value={fmtPct(m.holdersGrowthPct, 0)} tone={m.holdersGrowthPct > 0 ? 'pos' : undefined} />
          ) : (
            <Metric label="HOLDERS" value={fmtNum(m.holders)} />
          )}
        </div>

        <div className="card__quant" title={QUANT_DISCLAIMER}>
          <QuantMeter score={top ? top.score : null} />
          <span className="card__quant-score">QUANT MATCH {top ? `${Math.round(top.score)}%` : '—'}</span>
          {top && <span className="card__quant-name">· {top.name}</span>}
        </div>

        <div className="card__ai" id={aiId}>
          <EngineBadge engine={a.engine} model={a.model} />
          <span className="card__ai-text">{a.aiLine}</span>
        </div>
      </div>

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
