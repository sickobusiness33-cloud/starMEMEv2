import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ChainId, DetectionEvent } from '@shared/types';
import { rateLimitLeft, useRadar, type RecentSearch } from '../lib/radar';
import { notifyError } from '../lib/notify';
import { useClockWhile } from '../lib/time';
import { navigate } from '../lib/hash-router';
import { useChainOptions, validChainId } from '../lib/chains';
import { fmtTicker, shortAddr } from '../lib/format';
import { useStore } from '../store';
import { PHONE_QUERY, useMediaQuery } from '../lib/media';
import { useChainMeta } from './bits';
import { IconChevron, IconClose, IconSearch } from './Icons';

const QUERY_MAX = 120;

/**
 * Run an investigation and reflect it in the URL (#/radar?q=…&chain=…) so it can be shared.
 * While the server's rate limit is in force nothing is sent (it would only earn another 429):
 * the reader is told when they can search again and the screen keeps what it shows.
 */
export function startInvestigation(raw: string, chain: ChainId | null): void {
  const q = raw.trim().slice(0, QUERY_MAX);
  if (!q) return;
  const st = useRadar.getState();
  if (!st.run(q, chain)) {
    const left = rateLimitLeft(st.retryUntil, Date.now());
    if (left > 0) notifyError(`Too many radar searches — you can search again in ${left} s.`);
    return;
  }
  navigate('radar', { q, chain });
}

/** Seconds left on the radar rate limit (0 when free); re-renders each second only while a limit is in force. */
export function useRateLimitLeft(): number {
  const retryUntil = useRadar((s) => s.retryUntil);
  const now = useClockWhile(retryUntil !== null && retryUntil > Date.now());
  return rateLimitLeft(retryUntil, Math.max(now, Date.now()));
}

/** "/" from anywhere focuses the input; remembered across mounts so a remount does not re-steal focus. */
let handledFocusNonce = 0;

export function RadarSearch() {
  const query = useRadar((s) => s.query);
  const chain = useRadar((s) => s.chain);
  const phase = useRadar((s) => s.phase);
  const focusNonce = useStore((s) => s.radarFocusNonce);
  const options = useChainOptions();
  const [value, setValue] = useState(query ?? '');
  const [selected, setSelected] = useState<string>(chain ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  // the full placeholder needs ~310px of a 306px phone field at 16px (the iOS no-zoom minimum)
  const phone = useMediaQuery(PHONE_QUERY);
  const limitLeft = useRateLimitLeft();

  // follow investigations started elsewhere (deep link, candidate chip, recent search, leader click)
  useEffect(() => setValue(query ?? ''), [query]);
  useEffect(() => setSelected(chain ?? ''), [chain]);

  useEffect(() => {
    if (focusNonce <= handledFocusNonce) return;
    handledFocusNonce = focusNonce;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusNonce]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q) {
      inputRef.current?.focus();
      return;
    }
    startInvestigation(q, validChainId(selected));
    // phones: put the keyboard away so the investigation is what the reader sees
    if (window.matchMedia('(pointer: coarse)').matches) inputRef.current?.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (value) setValue('');
    else inputRef.current?.blur();
  };

  return (
    <form className="rsearch" role="search" aria-label="Investigate a token" onSubmit={submit} noValidate>
      <div className="rsearch__row">
        <div className="rsearch__field">
          <IconSearch size={16} className="rsearch__icon" />
          <input
            ref={inputRef}
            className="rsearch__input"
            type="search"
            name="q"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={phone ? 'Token / contract address' : 'Search token / contract address'}
            aria-label="Token symbol, name or contract address"
            aria-describedby={hintId}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            maxLength={QUERY_MAX}
          />
          {value && (
            <button
              type="button"
              className="rsearch__clear"
              aria-label="Clear search"
              onClick={() => {
                setValue('');
                inputRef.current?.focus();
              }}
            >
              <IconClose size={14} />
            </button>
          )}
        </div>
        <label className="rsearch__chain">
          <span className="sr-only">Chain</span>
          <select className="rsearch__select" value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Auto</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.short}
              </option>
            ))}
          </select>
          <IconChevron size={12} className="rsearch__chev" />
        </label>
        <button
          type="submit"
          className="btn btn--primary rsearch__submit"
          disabled={phase === 'starting' || limitLeft > 0}
          title={limitLeft > 0 ? `Rate-limited: search again in ${limitLeft} s` : undefined}
        >
          <IconSearch size={14} />
          Search
        </button>
      </div>
      <p id={hintId} className="rsearch__hint">
        {limitLeft > 0 ? (
          <span className="rsearch__limit">Too many searches — you can search again in {limitLeft} s</span>
        ) : (
          <>
            Symbol, name or contract address on {options.map((o) => o.short).join(' · ')}
            <span className="rsearch__kbd">
              {' '}
              · press <kbd>/</kbd> to search from anywhere
            </span>
          </>
        )}
      </p>
    </form>
  );
}

/* ───────────── recent searches (localStorage, handled in lib/radar) ───────────── */

export function RecentSearches() {
  const recent = useRadar((s) => s.recent);
  const removeRecent = useRadar((s) => s.removeRecent);
  const clearRecent = useRadar((s) => s.clearRecent);
  if (recent.length === 0) return null;
  return (
    <div className="chips-row" aria-label="Recent searches" role="group">
      <span className="label chips-row__label">Recent</span>
      <ul className="chips-row__list">
        {recent.map((r) => (
          <RecentChip key={`${r.chain ?? '*'}|${r.q}`} r={r} onRemove={() => removeRecent(r)} />
        ))}
      </ul>
      <button type="button" className="btn btn--sm btn--ghost chips-row__clear" onClick={clearRecent}>
        Clear
      </button>
    </div>
  );
}

function RecentChip({ r, onRemove }: { r: RecentSearch; onRemove: () => void }) {
  const text = r.label ?? (r.q.length > 24 ? shortAddr(r.q) : r.q);
  return (
    <li className="pair-chip">
      <button
        type="button"
        className="pair-chip__main"
        onClick={() => startInvestigation(r.q, r.chain)}
        title={`Investigate ${r.q}${r.chain ? ` on ${r.chain}` : ''}`}
      >
        {r.chain && <ChainDot chain={r.chain} />}
        <span className="pair-chip__text">{text}</span>
      </button>
      <button type="button" className="pair-chip__remove" aria-label={`Remove ${text} from recent searches`} onClick={onRemove}>
        <IconClose size={10} />
      </button>
    </li>
  );
}

function ChainDot({ chain }: { chain: ChainId }) {
  const meta = useChainMeta(chain);
  return <span className="dot" style={{ ['--dot' as string]: meta.color }} title={meta.name} aria-hidden="true" />;
}

/* ───────────── live suggestions from the signal tape (real detections only) ───────────── */

const SUGGESTIONS = 8;
const SEV_RANK: Record<DetectionEvent['severity'], number> = { BREAKING: 3, ALERT: 2, WATCH: 1 };

export function TapeSuggestions() {
  const detections = useStore((s) => s.detections);
  const picks = useMemo(() => {
    const seen = new Set<string>();
    const out: DetectionEvent[] = [];
    for (const e of detections) {
      const key = `${e.chain}:${e.address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.ts - a.ts).slice(0, SUGGESTIONS);
  }, [detections]);

  if (picks.length === 0) return null;
  return (
    <div className="chips-row" role="group" aria-label="Tokens the engine flagged recently">
      <span className="label chips-row__label">On the tape</span>
      <ul className="chips-row__list">
        {picks.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className="chip suggest-chip"
              data-sev={e.severity}
              onClick={() => startInvestigation(e.address, e.chain)}
              title={`${e.name} · ${e.severity} ${e.score} — investigate`}
            >
              <ChainDot chain={e.chain} />
              <span className="suggest-chip__sym">{fmtTicker(e.symbol)}</span>
              <span className="suggest-chip__score">{e.score}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
