import { memo, useMemo } from 'react';
import clsx from 'clsx';
import type { ChainId, Freshness, MarketRegime, NewsOutlook, QuantMatch, Severity } from '@shared/types';
import { QUANT_DISCLAIMER } from '@shared/types';
import { useStore } from '../store';
import { fallbackMeta, type ChainMeta } from '../lib/chains';
import { useNow } from '../lib/time';
import { fmtDateTime, fmtPct, timeAgo, timeAgoShort } from '../lib/format';

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

/**
 * Severity bands at the engine's DEFAULT thresholds (server THRESHOLD_WATCH / _ALERT /
 * _BREAKING). A deployment can tune them, so the UI always labels these as defaults.
 * Scores are calibrated so ALERT is roughly 42–59 and BREAKING 60+: a bar out of 100
 * would make a BREAKING 62 look "two-thirds empty", so the band is the headline and the
 * number is secondary.
 */
export const DEFAULT_BANDS: ReadonlyArray<{ severity: Severity; min: number }> = [
  { severity: 'WATCH', min: 22 },
  { severity: 'ALERT', min: 42 },
  { severity: 'BREAKING', min: 60 },
];

/** The band a score reaches at the default thresholds (null: below WATCH). */
export function bandOf(score: number): Severity | null {
  let out: Severity | null = null;
  for (const b of DEFAULT_BANDS) if (score >= b.min) out = b.severity;
  return out;
}

const BAND_RANK: Record<Severity, number> = { WATCH: 1, ALERT: 2, BREAKING: 3 };

/**
 * WATCH | ALERT | BREAKING meter. Bands up to the severity are filled; a band the score
 * reaches but the severity was held below (a cap) is outlined in amber; a tick marks where
 * the score sits inside the band it reaches.
 */
export function SeverityBands({ score, severity, capped = false }: { score: number; severity: Severity | null; capped?: boolean }) {
  const rank = severity ? BAND_RANK[severity] : 0;
  const reached = bandOf(score);
  const reachedRank = reached ? BAND_RANK[reached] : 0;
  const thresholds = DEFAULT_BANDS.map((b) => b.min).join(' / ');
  const summary = severity
    ? `${severity}${capped && reachedRank > rank ? `, held below ${reached}` : ''}: score ${Math.round(score)} on the default thresholds ${thresholds}.`
    : reached
      ? // a score past WATCH with no severity: the token was not eligible (the panel lists why)
        `No severity, not eligible: score ${Math.round(score)} would reach ${reached} on the default thresholds ${thresholds}.`
      : `Below WATCH: score ${Math.round(score)} on the default thresholds ${thresholds}.`;
  return (
    <div className="sevbands">
      <p className="sr-only">{summary}</p>
      <ol className="sevbands__track" aria-hidden="true">
        {DEFAULT_BANDS.map((b, i) => {
          const next = DEFAULT_BANDS[i + 1]?.min ?? 100;
          const here = reached === b.severity;
          const pos = here ? Math.max(0, Math.min(1, (score - b.min) / Math.max(1, next - b.min))) : null;
          return (
            <li
              key={b.severity}
              className="sevband"
              data-sev={b.severity}
              data-on={i < rank ? '' : undefined}
              data-current={i === rank - 1 ? '' : undefined}
              data-capped={capped && i >= rank && i < reachedRank ? '' : undefined}
            >
              <span className="sevband__bar">
                {pos !== null && <i className="sevband__tick" style={{ left: `${pos * 100}%` }} />}
              </span>
              <span className="sevband__label">{b.severity}</span>
              <span className="sevband__min">{b.min}+</span>
            </li>
          );
        })}
      </ol>
      <span className="sevbands__note" aria-hidden="true">
        Default thresholds
      </span>
    </div>
  );
}

/**
 * Severity caps, when the server reports them (Detection.caps, and `caps` on an article if
 * present): reasons a score that reached a higher band was held at `severity`. Read
 * defensively so a payload without the field (older server, older stored row) shows nothing.
 */
export function capsOf(x: object | null | undefined): string[] {
  if (!x || !('caps' in x) || !Array.isArray(x.caps)) return [];
  return x.caps.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
}

/** `compact`: one line per chip, cut with an ellipsis (the full reason is in the title), for the feed card. */
export function CapChips({ caps, severity, compact = false }: { caps: string[]; severity: Severity | null; compact?: boolean }) {
  if (caps.length === 0) return null;
  return (
    <ul className={clsx('cap-chips', compact && 'cap-chips--compact')} aria-label="Severity caps">
      {caps.map((c) => {
        const text = `${severity ? `Capped at ${severity}: ` : 'Capped: '}${c}`;
        return (
          <li key={c} className="cap-chip" title={compact ? text : undefined}>
            {text}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Relative time on the shared 15 s ticker. `compact` also renders the short form ("4m");
 * CSS shows it on phones (.ago__short) while screen readers keep the full words.
 */
export const TimeAgo = memo(function TimeAgo({ ts, className, compact = false }: { ts: number | null; className?: string; compact?: boolean }) {
  const now = useNow();
  if (ts === null) return <span className={className}>—</span>;
  return (
    <time className={clsx(className, compact && 'ago')} dateTime={new Date(ts).toISOString()} title={fmtDateTime(ts)}>
      {compact ? (
        <>
          <span className="ago__long">{timeAgo(ts, now)}</span>
          <span className="ago__short" aria-hidden="true">
            {timeAgoShort(ts, now)}
          </span>
        </>
      ) : (
        timeAgo(ts, now)
      )}
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
