import { useMemo, type ComponentType } from 'react';
import type { DerivedMetrics, TokenLink, TokenRef, TokenSnapshot } from '@shared/types';
import { dexscreenerUrl, explorerUrl } from '../lib/chains';
import { fmtAge, fmtTicker, fmtUsd, safeUrl, shortAddr } from '../lib/format';
import { ChainLabel, TokenImage, useChainMeta } from './bits';
import { CopyButton } from './CopyButton';
import { IconBlocks, IconChart, IconChat, IconExternal, IconGlobe, IconTelegram, IconX } from './Icons';
import { startInvestigation } from './RadarSearch';

type LinkIcon = ComponentType<{ size?: number }>;

const LINK_ICON: Record<TokenLink['type'], LinkIcon> = {
  website: IconGlobe,
  twitter: IconX,
  telegram: IconTelegram,
  discord: IconChat,
  other: IconExternal,
};

const LINK_LABEL: Record<TokenLink['type'], string> = {
  website: 'Website',
  twitter: 'X',
  telegram: 'Telegram',
  discord: 'Discord',
  other: 'Link',
};

/** `$SYMBOL Name` · chain · short address + copy · age · links. */
export function TokenHeader({ token, snapshot, metrics }: { token: TokenRef; snapshot: TokenSnapshot | null; metrics: DerivedMetrics | null }) {
  const links: Array<{ key: string; label: string; url: string; Icon: LinkIcon }> = [];
  links.push({
    key: 'dex',
    label: 'DexScreener',
    url: dexscreenerUrl(token.chain, snapshot?.pairAddress ?? token.address),
    Icon: IconChart,
  });
  const explorer = safeUrl(explorerUrl(token.chain, token.address));
  if (explorer) links.push({ key: 'explorer', label: 'Explorer', url: explorer, Icon: IconBlocks });
  const seen = new Set(links.map((l) => l.url));
  const labelCount = new Map<string, number>();
  for (const l of snapshot?.links ?? []) {
    const url = safeUrl(l.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const base = l.label?.trim() || LINK_LABEL[l.type];
    const n = (labelCount.get(base) ?? 0) + 1;
    labelCount.set(base, n);
    // two links of the same kind (e.g. two Discord servers) must stay distinguishable
    links.push({ key: `${l.type}:${url}`, label: n > 1 ? `${base} ${n}` : base, url, Icon: LINK_ICON[l.type] });
  }

  return (
    <header className="thead">
      <TokenImage src={token.imageUrl} symbol={token.symbol} size={28} />
      <div className="thead__id">
        <h2 className="thead__title">
          <span className="thead__sym">{fmtTicker(token.symbol)}</span>
          <span className="thead__name">{token.name}</span>
          {snapshot?.boosted && (
            <span className="tag tag--ghost" title="The listing is a paid promotion (DexScreener boost)">
              Boosted
            </span>
          )}
        </h2>
        <div className="thead__meta">
          <ChainLabel chain={token.chain} />
          {snapshot?.dex && <span className="thead__dex">{snapshot.dex}</span>}
          <span className="thead__addr">
            <span className="mono" title={token.address}>
              {shortAddr(token.address)}
            </span>
            <CopyButton text={token.address} what="Contract address" />
          </span>
          <span className="thead__age">
            <span className="label">Age</span> <span className="mono">{fmtAge(metrics?.ageMinutes ?? null)}</span>
          </span>
        </div>
      </div>
      <div className="thead__links">
        {links.map(({ key, label, url, Icon }) => (
          <a key={key} className="btn btn--sm" href={url} target="_blank" rel="noopener noreferrer" title={url}>
            <Icon size={12} />
            <span className="thead__link-label">{label}</span>
          </a>
        ))}
      </div>
    </header>
  );
}

/** Ambiguous symbol: the other tokens that matched, most liquid first. Clicking re-runs on that address + chain. */
export function Candidates({ candidates, token }: { candidates: TokenRef[]; token: TokenRef | null }) {
  // Several pools often share one ticker on one chain: those chips carry the short address so they stay distinguishable.
  const clashes = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of token ? [token, ...candidates] : candidates) {
      const k = `${c.chain}|${fmtTicker(c.symbol).toLowerCase()}`;
      n.set(k, (n.get(k) ?? 0) + 1);
    }
    return n;
  }, [candidates, token]);
  if (candidates.length === 0) return null;
  return (
    <div className="chips-row cands" role="group" aria-label="Other tokens matching this search">
      <span className="label chips-row__label">Also matching</span>
      <ul className="chips-row__list">
        {candidates.map((c) => (
          <li key={`${c.chain}:${c.address}`}>
            <CandidateChip c={c} showAddr={(clashes.get(`${c.chain}|${fmtTicker(c.symbol).toLowerCase()}`) ?? 0) > 1} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CandidateChip({ c, showAddr }: { c: TokenRef; showAddr: boolean }) {
  const chain = useChainMeta(c.chain);
  // the most useful size figure we actually have; an unknown one is left out rather than shown as "—"
  const size =
    c.liquidityUsd !== null ? `LIQ ${fmtUsd(c.liquidityUsd)}` : c.marketCapUsd !== null ? `MC ${fmtUsd(c.marketCapUsd)}` : null;
  return (
    <button
      type="button"
      className="chip cand-chip"
      onClick={() => startInvestigation(c.address, c.chain)}
      title={`${c.name} on ${chain.name} · ${c.address} — investigate this one instead`}
    >
      <span className="dot" style={{ ['--dot' as string]: chain.color }} aria-hidden="true" />
      <span className="cand-chip__sym">{fmtTicker(c.symbol)}</span>
      <span className="cand-chip__chain">{chain.short}</span>
      {showAddr && <span className="cand-chip__addr">{shortAddr(c.address)}</span>}
      {size && <span className="cand-chip__liq">{size}</span>}
    </button>
  );
}
