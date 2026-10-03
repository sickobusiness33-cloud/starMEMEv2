import { useMemo, useState } from 'react';
import type { Freshness, IntelItem, IntelProviderStatus, RadarStage } from '@shared/types';
import { useStore } from '../store';
import { fmtDate, safeUrl } from '../lib/format';
import { FreshnessTag, TimeAgo } from './bits';
import { IconExternal } from './Icons';

type Filter = 'ALL' | Exclude<Freshness, 'UNKNOWN'>;
const FILTERS: Filter[] = ['ALL', 'LIVE', 'RECENT', 'OLD'];
const PAGE = 12;

const PROVIDER_NAME: Record<string, string> = {
  gdelt: 'GDELT',
  hn: 'Hacker News',
  biz: '4chan /biz/',
  official: 'Official links',
  dexscreener: 'DexScreener',
  'claude-web': 'Claude web search',
};

const providerName = (p: string) => PROVIDER_NAME[p] ?? p;

/**
 * An item dated by calendar day only (publishedAt = that day's 00:00 UTC) cannot be placed
 * within the last hour: it is never LIVE, whatever the payload says.
 */
export function freshnessOf(it: Pick<IntelItem, 'freshness' | 'publishedPrecision'>): Freshness {
  return it.publishedPrecision === 'day' && it.freshness === 'LIVE' ? 'RECENT' : it.freshness;
}

interface ProviderResult {
  provider: string;
  ok: boolean;
  count: number | null;
  /** why it failed (or was not run), when the server said */
  error: string | null;
}

/**
 * Fallback for reports without `providers` (older server / stored reports): the web stage
 * also reports its providers in its message:
 * "12 mentions · gdelt 3 · hn 0 · biz failed · official 1 · claude-web 0"
 * (or, when all fail, "Every intel provider failed (gdelt failed · …)").
 */
export function parseProviders(message: string | null): ProviderResult[] {
  if (!message) return [];
  const out: ProviderResult[] = [];
  for (const part of message.replace(/[()]/g, ' · ').split('·')) {
    const m = /^([a-z][a-z0-9-]*) (failed|\d+)$/i.exec(part.trim());
    if (!m || !m[1] || !m[2]) continue;
    out.push({ provider: m[1], ok: m[2] !== 'failed', count: m[2] === 'failed' ? null : Number(m[2]), error: null });
  }
  return out;
}

/** The report's structured per-provider outcome when it has one, else what the stage message says. */
function providerResults(providers: IntelProviderStatus[] | undefined, stage: RadarStage | undefined): ProviderResult[] {
  if (providers && providers.length > 0) {
    return providers.map((p) => ({ provider: p.provider, ok: p.ok, count: p.ok ? p.count : null, error: p.error }));
  }
  return parseProviders(stage?.message ?? null);
}

/** Internet intel: freshness filter with counts, dated rows, and which sources answered. */
export function IntelPanel({
  intel,
  stage,
  providers,
}: {
  intel: IntelItem[];
  stage: RadarStage | undefined;
  /** RadarReport.providers (structured); absent or empty → parsed from the web stage message */
  providers?: IntelProviderStatus[];
}) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [limit, setLimit] = useState(PAGE);
  const busy = !stage || stage.status === 'pending' || stage.status === 'running';

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { ALL: intel.length, LIVE: 0, RECENT: 0, OLD: 0 };
    for (const it of intel) {
      const f = freshnessOf(it);
      if (f !== 'UNKNOWN') c[f] += 1;
    }
    return c;
  }, [intel]);

  const rows = useMemo(() => (filter === 'ALL' ? intel : intel.filter((it) => freshnessOf(it) === filter)), [intel, filter]);
  const shown = rows.slice(0, limit);

  return (
    <section className="panel rpanel intel" aria-labelledby="radar-intel">
      <div className="panel__head intel__head">
        <h3 className="section-title" id="radar-intel">
          Internet intel
        </h3>
        <div className="seg" role="group" aria-label="Filter mentions by freshness">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className="seg__btn"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
                setLimit(PAGE);
              }}
            >
              {f === 'LIVE' && <span className="dot" style={{ ['--dot' as string]: 'var(--green)' }} aria-hidden="true" />}
              {f}
              <span className="seg__count">{busy && intel.length === 0 ? '—' : counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      {busy && intel.length === 0 ? (
        <ul className="intel__list" aria-busy="true" aria-label="Searching the web">
          {[0, 1, 2].map((i) => (
            <li key={i} className="intel__row" aria-hidden="true">
              <span className="intel__meta">
                <span className="skel" style={{ width: 48, height: 16 }} />
                <span className="skel" style={{ width: 90, height: 10 }} />
              </span>
              <span className="skel" style={{ width: `${70 - i * 12}%`, height: 12 }} />
              <span className="skel" style={{ width: '90%', height: 10 }} />
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <p className="panel__body muted">
          {intel.length === 0
            ? stage?.status === 'error'
              ? 'No mentions: every source failed for this search.'
              : 'No mentions found in the sources that answered.'
            : `No ${filter} mentions. ${filter === 'LIVE' ? 'LIVE means published within the last hour.' : ''}`}
        </p>
      ) : (
        <ul className="intel__list">
          {shown.map((it) => (
            <IntelRow key={it.id} item={it} />
          ))}
        </ul>
      )}

      {rows.length > limit && (
        <div className="intel__more">
          <button type="button" className="btn btn--sm" onClick={() => setLimit((l) => l + PAGE * 2)}>
            Show {Math.min(rows.length - limit, PAGE * 2)} more
          </button>
          <span className="label">
            {shown.length} of {rows.length}
          </span>
        </div>
      )}

      <ProviderStatus stage={stage} providers={providers} />
    </section>
  );
}

function IntelRow({ item: it }: { item: IntelItem }) {
  const url = safeUrl(it.url);
  return (
    <li className="intel__row">
      <span className="intel__meta">
        <FreshnessTag freshness={freshnessOf(it)} />
        <span className="tag tag--ghost">{it.sourceType}</span>
        <span className="intel__source truncate" title={it.sourceName}>
          {it.sourceName}
        </span>
        {/* an undated item already says so in its freshness tag; a day-only date shows the date, never a time ago */}
        {it.publishedAt !== null &&
          (it.publishedPrecision === 'day' ? (
            <time
              className="intel__time"
              dateTime={new Date(it.publishedAt).toISOString().slice(0, 10)}
              title="The source gives the date only, not the time of day"
            >
              {fmtDate(it.publishedAt)}
            </time>
          ) : (
            <TimeAgo ts={it.publishedAt} className="intel__time" />
          ))}
      </span>
      {url ? (
        <a className="intel__title" href={url} target="_blank" rel="noopener noreferrer">
          <span>{it.title}</span>
          <IconExternal size={11} className="intel__ext" />
        </a>
      ) : (
        <span className="intel__title">{it.title}</span>
      )}
      {it.snippet && <p className="intel__snippet">{it.snippet}</p>}
      <span className="intel__via">
        Matched on {it.matchedOn} · via {providerName(it.provider)}
      </span>
    </li>
  );
}

/** Which sources answered and which failed — so an empty list is never mistaken for "no news". */
function ProviderStatus({ stage, providers }: { stage: RadarStage | undefined; providers: IntelProviderStatus[] | undefined }) {
  const ai = useStore((s) => s.stats?.engine.ai ?? null);
  const busy = !stage || stage.status === 'pending' || stage.status === 'running';
  const results = providerResults(providers, stage);

  return (
    <div className="providers" role="group" aria-label="Intel sources">
      <span className="label">Sources</span>
      {busy ? (
        <span className="providers__note">{stage?.status === 'running' ? 'Querying sources…' : 'Waiting for the web stage'}</span>
      ) : results.length === 0 ? (
        <span className="providers__note">{stage?.message ?? 'No source report'}</span>
      ) : (
        <ul className="providers__list">
          {results.map((p) => {
            // Claude web search only runs with an AI key: under the rules engine it is "off", not "failed"
            const off = p.provider === 'claude-web' && ai === 'rules' && (!p.ok || p.count === 0);
            const state = off ? 'off' : !p.ok ? 'failed' : p.count ? 'hit' : 'empty';
            const note = off ? 'off · no API key' : p.ok ? String(p.count ?? 0) : 'failed';
            return (
              <li key={p.provider} className="provider" data-state={state} title={p.error ?? undefined}>
                <span className="dot" aria-hidden="true" />
                {providerName(p.provider)}
                <span className="provider__n">{note}</span>
                {!off && !p.ok && p.error && <span className="sr-only">: {p.error}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
