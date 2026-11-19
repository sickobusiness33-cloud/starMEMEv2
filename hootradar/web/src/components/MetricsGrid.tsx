import type { ReactNode } from 'react';
import type { RadarReport, RadarStageId, TimeWindow, TokenSecurity, TxCounts } from '@shared/types';
import { DASH, fmtAge, fmtDateTime, fmtMult, fmtNum, fmtPct, fmtSplit, fmtUsd, fmtWindow } from '../lib/format';
import { BuySellBar, ChainLabel } from './bits';

interface Cell {
  key: string;
  label: string;
  /** null → "—" */
  value: ReactNode | null;
  sub?: ReactNode;
  /** `report.unavailable` field explaining a missing value */
  field?: string;
  /** reason used when the value is null and the server gave none */
  fallbackReason?: string;
  /** the stage that produces this value is still working */
  loading?: boolean;
  tone?: 'pos' | 'risk';
  title?: string;
}

const FLOW_LABEL: Record<'high' | 'normal' | 'low', string> = { high: 'High flow', normal: 'Normal flow', low: 'Low flow' };

const isNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

function txTotal(t: TxCounts | undefined): number | null {
  if (!t || (t.buys === null && t.sells === null)) return null;
  return (t.buys ?? 0) + (t.sells ?? 0);
}

function busy(r: RadarReport, id: RadarStageId): boolean {
  const s = r.stages.find((x) => x.id === id);
  return !s || s.status === 'pending' || s.status === 'running';
}

const pctTone = (n: number | null | undefined): 'pos' | undefined => (isNum(n) && n > 0 ? 'pos' : undefined);

function windowPair(label: string, a: string, b: string): string {
  return `${label} ${a} · ${b}`;
}

/** The on-chain picture of the token: label, value, sub-line; unknown → "—" + the reason. */
export function MetricsGrid({ report }: { report: RadarReport }) {
  const s = report.snapshot;
  const m = report.metrics;
  const reasons = new Map(report.unavailable.map((u) => [u.field, u.reason]));
  const onchainBusy = busy(report, 'onchain') || busy(report, 'resolve');
  const holdersBusy = busy(report, 'holders');

  const vol = s?.volumeUsd ?? {};
  const pc = s?.priceChangePct ?? {};
  const tx = s?.txns ?? {};
  const m5 = tx.m5;
  const h1 = tx.h1;
  const h24 = tx.h24;
  const sec = s?.security ?? null;
  const hasWallets = [m5?.buyers, m5?.sellers, h1?.buyers, h1?.sellers].some(isNum);

  const cells: Cell[] = [
    {
      key: 'chain',
      label: 'Blockchain',
      value: s ? <ChainLabel chain={s.chain} /> : report.token ? <ChainLabel chain={report.token.chain} /> : null,
      sub: s ? [s.dex, s.sources.join(' + ')].filter(Boolean).join(' · ') || null : null,
      loading: !s && busy(report, 'resolve'),
    },
    {
      key: 'price',
      label: 'Price',
      value: isNum(s?.priceUsd) ? fmtUsd(s.priceUsd) : null,
      sub: s ? windowPair('1H', fmtPct(pc.h1), `24H ${fmtPct(pc.h24)}`) : null,
      fallbackReason: 'Price not reported by the market-data providers.',
      loading: onchainBusy,
    },
    {
      key: 'mc',
      label: 'Market cap',
      value: isNum(s?.marketCapUsd) ? fmtUsd(s.marketCapUsd) : null,
      sub: isNum(s?.fdvUsd) ? `FDV ${fmtUsd(s.fdvUsd)}` : undefined,
      field: 'marketCap',
      loading: onchainBusy,
    },
    {
      key: 'liq',
      label: 'Liquidity',
      value: isNum(s?.liquidityUsd) ? fmtUsd(s.liquidityUsd) : null,
      sub: isNum(m?.liquidityChangePct) ? `Δ ${fmtPct(m.liquidityChangePct)} · tracked history` : 'Pool reserves, USD',
      tone: undefined,
      field: 'liquidity',
      loading: onchainBusy,
    },
    {
      key: 'vol',
      label: 'Volume 24H',
      value: isNum(vol.h24) ? fmtUsd(vol.h24) : null,
      sub: s ? windowPair('5M', fmtUsd(vol.m5), `1H ${fmtUsd(vol.h1)}`) : null,
      fallbackReason: 'Volume not reported by the market-data providers.',
      loading: onchainBusy,
    },
    {
      key: 'txns',
      label: 'Transactions 24H',
      value: txTotal(h24) !== null ? fmtNum(txTotal(h24)) : null,
      sub: s ? `1H ${fmtNum(txTotal(h1))}` : null,
      field: 'txns',
      loading: onchainBusy,
    },
    {
      key: 'txmin',
      label: 'Tx / min',
      value: isNum(m?.txPerMin) ? fmtNum(m.txPerMin) : null,
      sub: isNum(m?.txAcceleration) ? `${fmtMult(m.txAcceleration)} vs 1H average` : 'Last 5 minutes',
      field: 'txns',
      fallbackReason: 'Needs 5-minute transaction counts.',
      loading: onchainBusy,
    },
    {
      key: 'holders',
      label: 'Holders',
      value: isNum(s?.holders) ? fmtNum(s.holders) : null,
      sub: isNum(s?.top10HolderPct) ? `Top 10 hold ${fmtPct(s.top10HolderPct, 1, { sign: false })}` : undefined,
      field: 'holders',
      loading: holdersBusy && !isNum(s?.holders),
    },
    {
      key: 'hgrowth',
      label: 'Holder growth',
      value: isNum(m?.holdersGrowthPct) ? fmtPct(m.holdersGrowthPct) : null,
      sub: isNum(m?.holdersGrowthWindowMin) ? `Over ${Math.round(m.holdersGrowthWindowMin)} min` : undefined,
      tone: pctTone(m?.holdersGrowthPct),
      field: isNum(s?.holders) ? undefined : 'holders',
      fallbackReason: 'Needs an earlier holder count (3–60 min old) from our own snapshots.',
      loading: holdersBusy && !isNum(m?.holdersGrowthPct),
    },
    {
      key: 'bs',
      label: 'Buy / sell',
      value:
        isNum(m?.buyPct) && isNum(m?.sellPct) && fmtSplit(m.buyPct, m.sellPct) ? (
          <span className="mcell__bs">
            <span>{fmtSplit(m.buyPct, m.sellPct)}</span>
            <BuySellBar buy={m.buyPct} sell={m.sellPct} />
          </span>
        ) : null,
      sub: m?.buySellWindow ? `Share of trades · ${fmtWindow(m.buySellWindow as TimeWindow)} window` : undefined,
      field: s && txTotal(h24) === null && txTotal(h1) === null ? 'txns' : undefined,
      fallbackReason: 'Too few trades in every window for a meaningful split.',
      loading: onchainBusy,
    },
    {
      key: 'wallets',
      label: 'Wallet activity',
      value: hasWallets ? `${fmtNum(m5?.buyers)}\u202f/\u202f${fmtNum(m5?.sellers)}` : null,
      sub: hasWallets ? `Unique buyers / sellers, 5M · 1H\u00a0${fmtNum(h1?.buyers)}\u202f/\u202f${fmtNum(h1?.sellers)}` : undefined,
      fallbackReason: 'Unique-wallet counts come from GeckoTerminal pool data; not reported for this pool.',
      loading: onchainBusy,
    },
    {
      key: 'smart',
      label: 'Smart money',
      value: m?.largeWalletFlow ? FLOW_LABEL[m.largeWalletFlow] : null,
      sub: m?.largeWalletFlow ? 'Large-wallet proxy: average trade size vs liquidity' : undefined,
      tone: m?.largeWalletFlow === 'high' ? 'pos' : undefined,
      field: 'smartMoney',
      title: reasons.get('smartMoney'),
      loading: onchainBusy,
    },
    {
      key: 'momentum',
      label: 'Momentum',
      value: isNum(m?.momentumScore) ? signedInt(m.momentumScore) : null,
      sub: isNum(m?.momentumScore) ? windowPair('5M', fmtPct(pc.m5), `1H ${fmtPct(pc.h1)} · 6H ${fmtPct(pc.h6)}`) : undefined,
      tone: pctTone(m?.momentumScore),
      title: 'Composite of 5M / 1H / 6H price changes on a −100…100 scale',
      fallbackReason: 'Needs price changes from the providers.',
      loading: onchainBusy,
    },
    {
      key: 'vola',
      label: 'Volatility',
      value: isNum(m?.volatilityProxy) ? `${m.volatilityProxy.toFixed(1)} pp` : null,
      sub: isNum(m?.volatilityProxy) ? 'Dispersion of 5M / 1H / 6H moves, 1H-scaled' : undefined,
      fallbackReason: 'Needs price changes in at least two windows.',
      loading: onchainBusy,
    },
    {
      key: 'security',
      label: 'Security',
      value: sec ? securityValue(sec) : null,
      sub: sec ? securitySub(sec) : undefined,
      tone: sec && (sec.mintAuthority || sec.freezeAuthority || sec.honeypot === 'yes') ? 'risk' : undefined,
      fallbackReason: 'Security flags not reported by the holder data provider.',
      loading: holdersBusy && !sec,
    },
    {
      key: 'age',
      label: 'Token age',
      value: isNum(m?.ageMinutes) ? fmtAge(m.ageMinutes) : null,
      sub: isNum(s?.createdAt) ? fmtDateTime(s.createdAt) : undefined,
      field: 'ageMinutes',
      loading: onchainBusy,
    },
  ];

  return (
    <section className="panel rpanel" aria-labelledby="radar-metrics">
      <div className="panel__head">
        <h3 className="section-title" id="radar-metrics">
          On-chain metrics
        </h3>
        {s && <span className="label">{s.sources.length ? s.sources.join(' + ') : 'no provider'}</span>}
      </div>
      <dl className="mgrid">
        {cells.map((c) => (
          <MetricCell key={c.key} cell={c} reason={c.field ? reasons.get(c.field) : undefined} />
        ))}
      </dl>
    </section>
  );
}

function MetricCell({ cell: c, reason }: { cell: Cell; reason: string | undefined }) {
  const missing = c.value === null;
  const showSkel = missing && c.loading;
  const why = missing ? (reason ?? c.fallbackReason ?? 'Not available from the data received.') : null;
  return (
    <div className="mcell" data-na={missing && !showSkel ? '' : undefined} title={c.title ?? why ?? undefined}>
      <dt className="mcell__label">{c.label}</dt>
      <dd className={c.tone ? `mcell__value ${c.tone}` : 'mcell__value'}>
        {showSkel ? (
          <>
            <span className="skel mcell__skel" aria-hidden="true" />
            <span className="sr-only">Loading</span>
          </>
        ) : missing ? (
          DASH
        ) : (
          c.value
        )}
      </dd>
      <dd className="mcell__sub">{showSkel ? '' : missing ? why : c.sub}</dd>
    </div>
  );
}

/** +12 · −7 · 0 (rounded first, so −0.3 is "0", not "−0") */
function signedInt(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : r < 0 ? `−${Math.abs(r)}` : '0';
}

function securityValue(sec: TokenSecurity): string {
  const flags: string[] = [];
  if (sec.honeypot === 'yes') flags.push('Honeypot');
  if (sec.mintAuthority) flags.push('Mint on');
  if (sec.freezeAuthority) flags.push('Freeze on');
  if (flags.length) return flags.join(' · ');
  const known = sec.mintAuthority === false && sec.freezeAuthority === false && sec.honeypot === 'no';
  return known ? 'No flags' : 'Partial';
}

function securitySub(sec: TokenSecurity): string {
  const onOff = (v: boolean | null) => (v === null ? DASH : v ? 'on' : 'off');
  const dev = isNum(sec.devHoldingPct) ? ` · Dev ${fmtPct(sec.devHoldingPct, 1, { sign: false })}` : '';
  return `Mint ${onOff(sec.mintAuthority)} · Freeze ${onOff(sec.freezeAuthority)} · Honeypot ${sec.honeypot}${dev}`;
}
