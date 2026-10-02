import { memo, useMemo } from 'react';
import clsx from 'clsx';
import type { ChainId, Freshness, MarketRegime, NewsOutlook, QuantMatch, Severity } from '@shared/types';
import { QUANT_DISCLAIMER } from '@shared/types';
import { useStore } from '../store';
import { fallbackMeta, type ChainMeta } from '../lib/chains';
import { useNow } from '../lib/time';
import { fmtDateTime, fmtPct, timeAgo } from '../lib/format';

/** Chain metadata for one chain, selected as primitives so 5 s stats pushes do not re-render cards. */
export function useChainMeta(id: ChainId): ChainMeta {
  const name = useStore((s) => s.stats?.chains.find((c) => c.id === id)?.name);
  const short = useStore((s) => s.stats?.chains.find((c) => c.id === id)?.short);
  const color = useStore((s) => s.stats?.chains.find((c) => c.id === id)?.color);
  return useMemo(() => {
    const fb = fallbackMeta(id);
    return { id, name: name ?? fb.name, short: short ?? fb.short, color: color ?? fb.color };
  }, [id, name, short, color]);
}

export function ChainLabel({ chain, short = false }: { chain: ChainId; short?: boolean }) {
  const meta = useChainMeta(chain);
  return (
    <span className="chain-label">
      <span className="dot" style={{ ['--dot' as string]: meta.color }} aria-hidden="true" />
      {short ? meta.short : meta.name}
    </span>
  );
}

export function SeverityTag({ severity }: { severity: Severity }) {
  return <span className={clsx('tag', `tag--${severity.toLowerCase()}`)}>{severity}</span>;
}

/** Relative time on the shared 15 s ticker. */
export const TimeAgo = memo(function TimeAgo({ ts, className }: { ts: number | null; className?: string }) {
  const now = useNow();
  if (ts === null) return <span className={className}>—</span>;
  return (
    <time className={className} dateTime={new Date(ts).toISOString()} title={fmtDateTime(ts)}>
      {timeAgo(ts, now)}
    </time>
  );
});

/** 10-segment cyan meter. */
export function QuantMeter({ score }: { score: number | null }) {
  const filled = score === null ? 0 : Math.max(0, Math.min(10, Math.round(score / 10)));
  return (
    <span className="qmeter" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <i key={i} data-on={i < filled ? '' : undefined} />
      ))}
    </span>
  );
}

/** 2px buy/sell split: green / red at 70% opacity. */
export function BuySellBar({ buy, sell }: { buy: number | null; sell: number | null }) {
  if (buy === null || sell === null) return null;
  const total = buy + sell || 1;
  return (
    <span className="bsbar" aria-hidden="true">
      <i className="bsbar__buy" style={{ transform: `scaleX(${buy / total})` }} />
    </span>
  );
}

export function EngineBadge({ engine, model }: { engine: 'claude' | 'rules'; model: string | null }) {
  return engine === 'claude' ? (
    <span className="tag tag--ai" title={model ? `Written by Claude (${model})` : 'Written by Claude'}>
      AI
    </span>
  ) : (
    <span className="tag tag--rules" title="Written by the deterministic rules engine">
      Rules
    </span>
  );
}

export function EngineLine({ engine, model }: { engine: 'claude' | 'rules'; model: string | null }) {
  return (
    <span className="engine-line mono">
      {engine === 'claude' ? `CLAUDE · ${model ?? 'model unknown'}` : 'RULES ENGINE'}
    </span>
  );
}

export function OutlookTrio({ outlook }: { outlook: NewsOutlook }) {
  return (
    <div className="outlook">
      <div className="outlook__col" data-kind="bull">
        <span className="outlook__label">Bullish</span>
        <p>{outlook.bullish}</p>
      </div>
      <div className="outlook__col" data-kind="neutral">
        <span className="outlook__label">Neutral</span>
        <p>{outlook.neutral}</p>
      </div>
      <div className="outlook__col" data-kind="risk">
        <span className="outlook__label">Risk</span>
        <p>{outlook.risk}</p>
      </div>
    </div>
  );
}

const FAMILY_LABEL: Record<string, string> = {
  momentum: 'Momentum',
  trend: 'Trend',
  breakout: 'Breakout',
  mean_reversion: 'Mean reversion',
  volume: 'Volume',
  volatility: 'Volatility',
  liquidity: 'Liquidity',
  order_flow: 'Order flow',
  attention: 'Attention',
  regime: 'Regime',
  risk: 'Risk',
};

export function familyLabel(f: string): string {
  return FAMILY_LABEL[f] ?? f.replace(/_/g, ' ');
}

/** Score bar row for quant matches. */
export function MatchBars({ matches }: { matches: QuantMatch[] }) {
  if (matches.length === 0) return <p className="muted">No methodology resembles current conditions.</p>;
  return (
    <ul className="matches" title={QUANT_DISCLAIMER}>
      {matches.map((m) => (
        <li key={m.methodologyId} className="match">
          <div className="match__top">
            <span className="match__name">{m.name}</span>
            <span className="tag tag--ghost">{familyLabel(m.family)}</span>
            <span className="match__score mono">{Math.round(m.score)}%</span>
          </div>
          <div className="bar">
            <i className="bar__fill" style={{ transform: `scaleX(${Math.max(0, Math.min(1, m.score / 100))})` }} />
          </div>
          <div className="match__foot">
            <span className="muted mono">Coverage {fmtPct(m.coverage * 100, 0, { sign: false })}</span>
            {m.rationale && <span className="match__why">{m.rationale}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

const FRESH_LABEL: Record<Freshness, string> = { LIVE: 'Live', RECENT: 'Recent', OLD: 'Old', UNKNOWN: 'Undated' };

export function FreshnessTag({ freshness }: { freshness: Freshness }) {
  return (
    <span className={clsx('tag', `tag--${freshness.toLowerCase()}`)}>
      {freshness === 'LIVE' && <span className="dot" style={{ ['--dot' as string]: 'var(--green)' }} aria-hidden="true" />}
      {FRESH_LABEL[freshness]}
    </span>
  );
}

export function TokenImage({ src, symbol, size = 28 }: { src: string | null; symbol: string; size?: number }) {
  const letter = (symbol.replace(/[^a-z0-9]/gi, '')[0] ?? '?').toUpperCase();
  return (
    <span className="token-img" style={{ width: size, height: size }}>
      <span className="token-img__letter" aria-hidden="true">
        {letter}
      </span>
      {src && (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      )}
    </span>
  );
}

const REGIME_TONE: Record<MarketRegime['label'], string> = {
  'risk-on': 'tag--live',
  neutral: 'tag--ghost',
  'risk-off': 'tag--risk',
  unknown: 'tag--unknown',
};

/** Market regime as a compact tag: `Regime risk-on`. */
export function RegimeTag({ regime }: { regime: MarketRegime }) {
  const detail =
    regime.breadthPct !== null
      ? `${Math.round(regime.breadthPct)}% of ${regime.sampleSize} tracked tokens up over 1H`
      : `Not enough tracked tokens to classify the market (${regime.sampleSize})`;
  return (
    <span className={clsx('tag', REGIME_TONE[regime.label])} title={detail}>
      Regime {regime.label}
    </span>
  );
}
