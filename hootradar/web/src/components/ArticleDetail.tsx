import type { ComponentType } from 'react';
import type { DistributionItem, NewsArticle } from '@shared/types';
import { QUANT_DISCLAIMER } from '@shared/types';
import { useStore } from '../store';
import { navigate } from '../lib/hash-router';
import { fmtClock, fmtMs, safeUrl } from '../lib/format';
import { CopyButton } from './CopyButton';
import { EngineLine, MatchBars, OutlookTrio, SeverityTag, TimeAgo } from './bits';
import { IconBlocks, IconChart, IconGlobe, IconRadar, IconRefresh, IconTelegram, IconX } from './Icons';

/** The full article, rendered inside an expanded NewsCard. */
export function ArticleDetail({ article: a }: { article: NewsArticle }) {
  return (
    <div className="detail">
      <header className="detail__head">
        <h3 className="detail__headline">{a.headline}</h3>
        <p className="detail__lede">{a.lede}</p>
      </header>

      <section className="detail__sec" aria-labelledby={`${a.id}-why`}>
        <h4 className="section-title" id={`${a.id}-why`}>
          Why it matters
        </h4>
        <ul className="bullets">
          {a.whyItMatters.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      </section>

      <section className="detail__sec" aria-labelledby={`${a.id}-quant`}>
        <h4 className="section-title" id={`${a.id}-quant`}>
          Quant analysis
          <RegimeChip label={a.quant.regime.label} />
        </h4>
        <p className="detail__text">{a.quantAnalysis}</p>
        <MatchBars matches={a.quant.matches.slice(0, 3)} />
        <p className="disclaimer">{QUANT_DISCLAIMER}</p>
      </section>

      <section className="detail__sec" aria-labelledby={`${a.id}-outlook`}>
        <h4 className="section-title" id={`${a.id}-outlook`}>
          AI outlook
          <EngineLine engine={a.engine} model={a.model} />
        </h4>
        <OutlookTrio outlook={a.outlook} />
      </section>

      <div className="detail__split">
        <section className="detail__sec" aria-labelledby={`${a.id}-signals`}>
          <h4 className="section-title" id={`${a.id}-signals`}>
            Signals <span className="muted mono">score {a.score}</span>
          </h4>
          {a.signals.length === 0 ? (
            <p className="muted">No signal breakdown.</p>
          ) : (
            <ul className="signals">
              {[...a.signals]
                .sort((x, y) => y.weight - x.weight)
                .map((s) => (
                  <li key={s.code} className="signal">
                    <span className="signal__label">{s.label}</span>
                    <span className="signal__weight mono">+{Math.round(s.weight)}</span>
                  </li>
                ))}
            </ul>
          )}
        </section>
        <section className="detail__sec" aria-labelledby={`${a.id}-risk`}>
          <h4 className="section-title" id={`${a.id}-risk`}>
            Risk flags
          </h4>
          {a.quant.riskFlags.length === 0 ? (
            <p className="muted">No risk flags raised by the data we have.</p>
          ) : (
            <ul className="flags">
              {a.quant.riskFlags.map((f) => (
                <li key={f} className="tag tag--risk">
                  {f}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <PipelineStrip article={a} />

      <div className="detail__links">
        <LinkRow article={a} />
        <CopyButton text={a.address} what="Contract address" label="Copy contract" />
      </div>

      <Distribution articleId={a.id} />

      <footer className="detail__foot mono">
        <span>{a.engine === 'claude' ? `Written by Claude · ${a.model ?? 'model unknown'}` : 'Written by the rules engine'}</span>
        <span>Lang {a.lang.toUpperCase()}</span>
        {a.updateOf && <span>Update of {a.updateOf.slice(0, 8)}</span>}
        <span className="truncate" title={a.address}>
          {a.address}
        </span>
      </footer>
    </div>
  );
}

function RegimeChip({ label }: { label: string }) {
  const tone = label === 'risk-on' ? 'tag--live' : label === 'risk-off' ? 'tag--risk' : 'tag--ghost';
  return <span className={`tag ${tone}`}>Regime {label}</span>;
}

/* ───────────── pipeline timings ───────────── */

export function pipelineSteps(p: NewsArticle['pipeline']) {
  return [
    { id: 'detect', label: 'Detect', delta: null as number | null, at: p.detectedAt },
    { id: 'analyze', label: 'Analyze', delta: p.analyzedAt - p.detectedAt, at: p.analyzedAt },
    { id: 'quant', label: 'Quant', delta: p.quantAt - p.analyzedAt, at: p.quantAt },
    { id: 'write', label: 'Write', delta: p.writtenAt - p.quantAt, at: p.writtenAt },
    { id: 'publish', label: 'Publish', delta: p.publishedAt - p.writtenAt, at: p.publishedAt },
  ];
}

function PipelineStrip({ article: a }: { article: NewsArticle }) {
  const steps = pipelineSteps(a.pipeline);
  const total = a.pipeline.publishedAt - a.pipeline.detectedAt;
  return (
    <section className="detail__sec" aria-label="Pipeline timing">
      <ol className="pipe-strip">
        {steps.map((s, i) => (
          <li key={s.id} className="pipe-strip__step">
            {i > 0 && (
              <span className="pipe-strip__arrow" aria-hidden="true">
                →
              </span>
            )}
            <span className="pipe-strip__label">{s.label}</span>
            <span className="pipe-strip__value mono">{s.delta === null ? `${fmtClock(s.at)}` : `+${fmtMs(s.delta)}`}</span>
          </li>
        ))}
        <li className="pipe-strip__total">
          <span className="pipe-strip__label">Total</span>
          <span className="pipe-strip__value mono">{fmtMs(total)}</span>
        </li>
      </ol>
    </section>
  );
}

/* ───────────── links ───────────── */

function LinkRow({ article: a }: { article: NewsArticle }) {
  const links: Array<{ key: string; label: string; url: string | null; Icon: ComponentType<{ size?: number }> }> = [
    { key: 'dex', label: 'DexScreener', url: safeUrl(a.links.dexscreener), Icon: IconChart },
    { key: 'explorer', label: 'Explorer', url: safeUrl(a.links.explorer), Icon: IconBlocks },
    { key: 'web', label: 'Website', url: safeUrl(a.links.website), Icon: IconGlobe },
    { key: 'x', label: 'X', url: safeUrl(a.links.twitter), Icon: IconX },
    { key: 'tg', label: 'Telegram', url: safeUrl(a.links.telegram), Icon: IconTelegram },
  ];
  return (
    <div className="link-row">
      {links
        .filter((l) => l.url)
        .map(({ key, label, url, Icon }) => (
          <a key={key} className="btn btn--sm" href={url ?? undefined} target="_blank" rel="noopener noreferrer">
            <Icon size={12} />
            {label}
          </a>
        ))}
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => navigate('radar', { q: a.address, chain: a.chain })}
        title="Run a full Radar investigation on this token"
      >
        <IconRadar size={12} />
        Radar
      </button>
    </div>
  );
}

/* ───────────── distribution (lazy: /api/articles/:id) ───────────── */

const CHANNEL_LABEL: Record<string, string> = { x: 'X', telegram: 'Telegram', discord: 'Discord', webhook: 'Webhook' };
const STATUS_TONE: Record<string, string> = {
  ready: 'tag--ghost',
  queued: 'tag--alert',
  sent: 'tag--live',
  failed: 'tag--risk',
  skipped: 'tag--ghost',
};

function prettyPayload(d: DistributionItem): string {
  if (d.channel === 'discord' || d.channel === 'webhook') {
    try {
      return JSON.stringify(JSON.parse(d.payload), null, 2);
    } catch {
      return d.payload;
    }
  }
  return d.payload;
}

function Distribution({ articleId }: { articleId: string }) {
  const detail = useStore((s) => s.details[articleId]);
  const reload = useStore((s) => s.loadDetail);
  const items = detail?.data?.distribution ?? [];
  const related = detail?.data?.related ?? [];

  return (
    <section className="detail__sec" aria-labelledby={`${articleId}-dist`} aria-busy={detail?.status === 'loading'}>
      <h4 className="section-title" id={`${articleId}-dist`}>
        Distribution
        <button
          type="button"
          className="btn btn--sm btn--ghost btn--icon dist__reload"
          onClick={() => reload(articleId, true)}
          aria-label="Reload distribution status"
          title="Reload distribution status"
        >
          <IconRefresh size={12} />
        </button>
      </h4>

      {(!detail || (detail.status === 'loading' && !detail.data)) && (
        <div className="dist-grid" aria-hidden="true">
          {[0, 1].map((i) => (
            <div key={i} className="dist dist--skel">
              <span className="skel" style={{ width: '40%', height: 10 }} />
              <span className="skel" style={{ width: '100%', height: 56 }} />
            </div>
          ))}
        </div>
      )}

      {detail?.status === 'error' && (
        <p className="dist__error">
          Distribution unavailable — {detail.error}{' '}
          <button type="button" className="link" onClick={() => reload(articleId, true)}>
            Retry
          </button>
        </p>
      )}

      {detail?.data && items.length === 0 && <p className="muted">No distribution items for this article.</p>}

      {items.length > 0 && (
        <ul className="dist-grid">
          {items.map((d) => (
            <li key={d.id} className="dist">
              <div className="dist__head">
                <span className="dist__channel">{CHANNEL_LABEL[d.channel] ?? d.channel}</span>
                <span className={`tag ${STATUS_TONE[d.status] ?? 'tag--ghost'}`}>{d.status}</span>
                {d.channel === 'x' && <span className="muted mono dist__count">{d.payload.length}/280</span>}
                <span className="dist__spacer" />
                <CopyButton text={d.payload} what={`${CHANNEL_LABEL[d.channel] ?? d.channel} payload`} label="Copy" />
              </div>
              <pre className="dist__payload">{prettyPayload(d)}</pre>
              {(d.sentAt || d.error) && (
                <div className="dist__foot mono">
                  {d.sentAt && (
                    <span>
                      Sent <TimeAgo ts={d.sentAt} />
                    </span>
                  )}
                  {d.error && (
                    <span className="risk truncate" title={d.error}>
                      {d.error}
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {related.length > 0 && (
        <div className="related">
          <span className="label">Earlier detections · same token</span>
          <ul className="related__list">
            {related.slice(0, 6).map((e) => (
              <li key={e.id} className="related__row mono">
                <span className="muted">{fmtClock(e.ts)}</span>
                <SeverityTag severity={e.severity} />
                <span>score {e.score}</span>
                <span className="truncate muted">{[...e.signals].sort((x, y) => y.weight - x.weight)[0]?.label ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

