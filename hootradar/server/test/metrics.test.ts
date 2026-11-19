import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DerivedMetrics, TokenSnapshot } from '../../shared/types.js';
import { deriveMetrics, toCardMetrics } from '../src/engine/metrics.js';
import { parseDsPairs } from '../src/sources/dexscreener.js';
import { parseGtPools } from '../src/sources/geckoterminal.js';
import { parsePumpCoins } from '../src/sources/pumpfun.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 1, 21, 10);

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

function snap(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    chain: 'solana',
    address: '6nyVgjjPGY9c7QpjMUPY8vS6sLzVoiq9VyxYoTvmpump',
    symbol: 'TEST',
    name: 'Test',
    pairAddress: null,
    dex: null,
    ts: T0,
    priceUsd: null,
    marketCapUsd: null,
    fdvUsd: null,
    liquidityUsd: null,
    volumeUsd: {},
    priceChangePct: {},
    txns: {},
    holders: null,
    top10HolderPct: null,
    createdAt: null,
    imageUrl: null,
    links: [],
    security: null,
    sources: [],
    boosted: false,
    ...over,
  };
}

const tx = (buys: number, sells: number, buyers: number | null = null, sellers: number | null = null) => ({
  buys,
  sells,
  buyers,
  sellers,
});

const ALL_METRIC_KEYS: Array<keyof DerivedMetrics> = [
  'ageMinutes',
  'txPerMin',
  'txAcceleration',
  'volumeAcceleration',
  'buyPct',
  'sellPct',
  'buySellWindow',
  'uniqueBuyersM5',
  'buyerAcceleration',
  'holdersGrowthPct',
  'holdersGrowthWindowMin',
  'liquidityChangePct',
  'momentumScore',
  'volatilityProxy',
  'avgTradeUsd',
  'largeWalletFlow',
  'volumeToLiquidity',
  'illiquidity',
];

describe('deriveMetrics on real provider data', () => {
  it('GeckoTerminal pool (STONKR, 15 minutes old): age-aware rates, wallet counts, Amihud', () => {
    const pools = parseGtPools(fixture('gt_new_pools_base.json'), 'base', T0);
    const s = pools.find((p) => p.symbol === 'STONKR');
    expect(s?.createdAt).not.toBeNull();
    if (!s?.createdAt) return;
    const now = s.createdAt + 15 * MIN;
    const m = deriveMetrics({ ...s, ts: now }, [], now);

    // fixture: m5 49 buys / 46 sells (23 buyers), h1 174 / 134 (30 buyers), vol h1 $92,073.65, liq $7,360.80
    expect(m.ageMinutes).toBeCloseTo(15, 6);
    expect(m.txPerMin).toBeCloseTo(95 / 5, 6);
    // the token is 15 minutes old, so its "h1" holds 15 minutes of trades: (95/5) / (308/15)
    expect(m.txAcceleration).toBeCloseTo(19 / (308 / 15), 6);
    expect(m.buyPct).toBeCloseTo((49 / 95) * 100, 6);
    expect(m.sellPct).toBeCloseTo((46 / 95) * 100, 6);
    expect(m.buySellWindow).toBe('m5');
    expect(m.uniqueBuyersM5).toBe(23);
    expect(m.buyerAcceleration).toBeCloseTo(23 / 5 / (30 / 15), 6);
    expect(m.avgTradeUsd).toBeCloseTo(92073.6481958185 / 308, 6);
    expect(m.largeWalletFlow).toBe('normal');
    expect(m.volumeToLiquidity).toBeCloseTo(92073.6481958185 / 7360.8047, 6); // young → h1 volume
    expect(m.illiquidity).toBeCloseTo(163.216 / (92073.6481958185 / 1e6), 3);
    // h1 and h6 (+163%) only measure the 15 minutes since launch, so momentum rests on m5 (+4.007%) alone
    expect(m.momentumScore).toBeCloseTo(100 * Math.tanh(4.007 / 10), 6);
    // no holder data from this provider and no history → unknown, not zero
    expect(m.holdersGrowthPct).toBeNull();
    expect(m.holdersGrowthWindowMin).toBeNull();
    expect(m.liquidityChangePct).toBeNull();
  });

  it('DexScreener pair (Bonk): no wallet counts → buyer metrics are null, not zero', () => {
    const s = parseDsPairs(fixture('ds_tokens_solana.json'), 'solana', T0).find(
      (p) => p.address === 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    );
    expect(s).toBeDefined();
    if (!s) return;
    const m = deriveMetrics(s, [], T0);

    // fixture: m5 10/10, h1 133/223, vol m5 $487.23, h1 $15,122.45, h24 $904,228.83, liq $425,802.43
    expect(m.uniqueBuyersM5).toBeNull();
    expect(m.buyerAcceleration).toBeNull();
    expect(m.txPerMin).toBeCloseTo(4, 6);
    expect(m.txAcceleration).toBeCloseTo(4 / (356 / 60), 6);
    expect(m.volumeAcceleration).toBeCloseTo(487.23 / 5 / (15122.45 / 60), 6);
    expect(m.buyPct).toBeCloseTo(50, 6);
    expect(m.buySellWindow).toBe('m5');
    expect(m.avgTradeUsd).toBeCloseTo(15122.45 / 356, 6);
    expect(m.largeWalletFlow).toBe('low');
    expect(m.volumeToLiquidity).toBeCloseTo(904228.83 / 425802.43, 6); // old token → h24 volume
    expect(m.ageMinutes).toBeGreaterThan(365 * 24 * 60);
  });

  it('pump.fun coin without market activity yields nulls everywhere except age', () => {
    const coin = parsePumpCoins(fixture('pumpfun_newest.json'), T0)[0];
    expect(coin).toBeDefined();
    if (!coin?.createdAt) return;
    const now = coin.createdAt + 2 * MIN;
    const m = deriveMetrics({ ...coin, ts: now }, [], now);

    expect(m.ageMinutes).toBeCloseTo(2, 6);
    for (const key of ALL_METRIC_KEYS.filter((k) => k !== 'ageMinutes')) {
      expect(m[key], key).toBeNull();
    }
  });
});

describe('deriveMetrics edge cases', () => {
  it('treats an empty snapshot as entirely unknown', () => {
    const m = deriveMetrics(snap(), [], T0);
    for (const key of ALL_METRIC_KEYS) expect(m[key], key).toBeNull();
  });

  it('keeps zero activity as a real zero where it is measured', () => {
    const m = deriveMetrics(snap({ txns: { m5: tx(0, 0, 0, 0) } }), [], T0);
    expect(m.txPerMin).toBe(0);
    expect(m.uniqueBuyersM5).toBe(0);
    expect(m.txAcceleration).toBeNull();
  });

  it('a partially known tx count is unknown', () => {
    const m = deriveMetrics(snap({ txns: { m5: { buys: 12, sells: null, buyers: null, sellers: null } } }), [], T0);
    expect(m.txPerMin).toBeNull();
    expect(m.buyPct).toBeNull();
  });

  it('accelerations compare against a full hour only when the pool covers it, and need enough h1 activity', () => {
    const counts = { txns: { m5: tx(30, 20, 25), h1: tx(80, 70, 40) }, volumeUsd: { m5: 5000, h1: 15000 } };
    const m = deriveMetrics(snap({ ...counts, pairCreatedAt: T0 - 3 * HOUR }), [], T0);
    expect(m.txAcceleration).toBeCloseTo(50 / 5 / (150 / 60), 6);
    expect(m.volumeAcceleration).toBeCloseTo(5000 / 5 / (15000 / 60), 6);
    expect(m.buyerAcceleration).toBeCloseTo(25 / 5 / (40 / 60), 6);

    // unknown pool and token age: assuming a full hour would turn a young pool's launch into a "6x" surge
    const unknown = deriveMetrics(snap(counts), [], T0);
    expect(unknown.txAcceleration).toBeNull();
    expect(unknown.volumeAcceleration).toBeNull();
    expect(unknown.buyerAcceleration).toBeNull();

    const thin = deriveMetrics(
      snap({ txns: { m5: tx(3, 3, 3), h1: tx(5, 4, 4) }, volumeUsd: { m5: 100, h1: 499 }, pairCreatedAt: T0 - 3 * HOUR }),
      [],
      T0,
    );
    expect(thin.txAcceleration).toBeNull(); // 9 h1 trades < 10
    expect(thin.volumeAcceleration).toBeNull(); // $499 < $500
    expect(thin.buyerAcceleration).toBeNull(); // 4 h1 buyers < 5
  });

  it('a token younger than 5 minutes shows no fake acceleration', () => {
    const m = deriveMetrics(
      snap({ createdAt: T0 - 3 * MIN, txns: { m5: tx(40, 20), h1: tx(40, 20) }, volumeUsd: { m5: 9000, h1: 9000 } }),
      [],
      T0,
    );
    expect(m.txAcceleration).toBeCloseTo(1, 6);
    expect(m.volumeAcceleration).toBeCloseTo(1, 6);
    expect(m.txPerMin).toBeCloseTo(60 / 3, 6);
  });

  it('buy share uses the shortest window with at least 10 trades', () => {
    const fromH1 = deriveMetrics(snap({ txns: { m5: tx(4, 1), h1: tx(21, 9), h24: tx(100, 100) } }), [], T0);
    expect(fromH1.buySellWindow).toBe('h1');
    expect(fromH1.buyPct).toBeCloseTo(70, 6);
    expect(fromH1.sellPct).toBeCloseTo(30, 6);

    const none = deriveMetrics(snap({ txns: { m5: tx(1, 1), h1: tx(4, 4), h24: tx(4, 5) } }), [], T0);
    expect(none.buyPct).toBeNull();
    expect(none.sellPct).toBeNull();
    expect(none.buySellWindow).toBeNull();
  });

  it('holder and liquidity growth use the oldest qualifying snapshot of the last hour', () => {
    const pool = { pairAddress: 'PoolA111', liquiditySource: 'dexscreener' };
    const history = [
      snap({ ...pool, ts: T0 - 70 * MIN, holders: 50, liquidityUsd: 1000 }), // too old
      snap({ ...pool, ts: T0 - 50 * MIN, holders: null, liquidityUsd: 8000 }),
      snap({ ...pool, ts: T0 - 40 * MIN, holders: 100, liquidityUsd: 9000 }),
      snap({ ...pool, ts: T0 - 20 * MIN, holders: 120, liquidityUsd: 9500 }),
      snap({ ...pool, ts: T0 - 2 * MIN, holders: 140, liquidityUsd: 9900 }), // too recent
    ];
    const current = snap({ ...pool, ts: T0, holders: 150, liquidityUsd: 10_000 });
    const m = deriveMetrics(current, [...history, current], T0);

    expect(m.holdersGrowthPct).toBeCloseTo(50, 6);
    expect(m.holdersGrowthWindowMin).toBeCloseTo(40, 6);
    expect(m.liquidityChangePct).toBeCloseTo(25, 6);
  });

  it('never measures liquidity growth across a pool switch, a provider switch or a quote-backing cap', () => {
    // live regression: pool A $12K then pool B $40K read as "+233% liquidity"
    const a = { pairAddress: 'PoolA111', liquiditySource: 'dexscreener' };
    const growth = (ref: Partial<TokenSnapshot>, cur: Partial<TokenSnapshot>) => {
      const current = snap({ ts: T0, ...cur });
      return deriveMetrics(current, [snap({ ts: T0 - 20 * MIN, ...ref }), current], T0).liquidityChangePct;
    };
    expect(growth({ ...a, liquidityUsd: 12_000 }, { ...a, liquidityUsd: 15_000 })).toBeCloseTo(25, 6);
    expect(growth({ ...a, liquidityUsd: 12_000 }, { ...a, pairAddress: 'PoolB222', liquidityUsd: 40_000 })).toBeNull();
    expect(growth({ ...a, liquidityUsd: 12_000 }, { ...a, liquiditySource: 'geckoterminal', liquidityUsd: 40_000 })).toBeNull();
    // quote reserve 4,900 → $9.8K (capped) vs 5,100 → $100K (as reported): a 4% change, not +920%
    expect(
      growth({ ...a, liquidityUsd: 9_800, liquidityAdjusted: true }, { ...a, liquidityUsd: 100_000, liquidityAdjusted: false }),
    ).toBeNull();
    // snapshots stored before provenance existed are never compared
    expect(growth({ liquidityUsd: 12_000 }, { liquidityUsd: 40_000 })).toBeNull();
    // EVM pool addresses compare case-insensitively
    expect(
      growth({ ...a, pairAddress: '0xAbC0000000000000000000000000000000000001', liquidityUsd: 10_000 }, { ...a, pairAddress: '0xabc0000000000000000000000000000000000001', liquidityUsd: 12_000 }),
    ).toBeCloseTo(20, 6);
  });

  it('5m-vs-1h ratios use the age of the pool the windows were measured on', () => {
    // live regression: a 40-minute-old pump.fun coin whose PumpSwap pool is 5 minutes old has m5 ≈ h1
    const counts = { txns: { m5: tx(60, 40), h1: tx(65, 45) }, volumeUsd: { m5: 9_000, h1: 10_000 } };
    const graduated = deriveMetrics(snap({ ...counts, createdAt: T0 - 40 * MIN, pairCreatedAt: T0 - 5 * MIN }), [], T0);
    expect(graduated.windowAgeMinutes).toBeCloseTo(5, 6);
    expect(graduated.txAcceleration).toBeCloseTo(100 / 110, 6); // ≈1: the pool's whole life, not an 8x surge
    expect(graduated.txPerMin).toBeCloseTo(100 / 5, 6);
    // the token's age alone (40 min) cannot tell how long the pool has existed
    const unknownPool = deriveMetrics(snap({ ...counts, createdAt: T0 - 40 * MIN }), [], T0);
    expect(unknownPool.windowAgeMinutes).toBeNull();
    expect(unknownPool.txAcceleration).toBeNull();
    expect(unknownPool.ageMinutes).toBeCloseTo(40, 6);
  });

  it('growth is unknown without a usable reference or a current value', () => {
    const recentOnly = [snap({ ts: T0 - 2 * MIN, holders: 100, liquidityUsd: 5000 })];
    const m = deriveMetrics(snap({ holders: 150, liquidityUsd: 6000 }), recentOnly, T0);
    expect(m.holdersGrowthPct).toBeNull();
    expect(m.holdersGrowthWindowMin).toBeNull();
    expect(m.liquidityChangePct).toBeNull();

    const zeroRef = [snap({ ts: T0 - 30 * MIN, holders: 0 })];
    expect(deriveMetrics(snap({ holders: 10 }), zeroRef, T0).holdersGrowthPct).toBeNull();

    const usable = [snap({ ts: T0 - 30 * MIN, holders: 100 })];
    expect(deriveMetrics(snap({ holders: null }), usable, T0).holdersGrowthPct).toBeNull();
  });

  it('momentum is bounded, signed, and renormalized over the windows that exist', () => {
    const up = deriveMetrics(snap({ priceChangePct: { m5: 100, h1: 100, h6: 100 } }), [], T0).momentumScore;
    const down = deriveMetrics(snap({ priceChangePct: { m5: -100, h1: -100, h6: -100 } }), [], T0).momentumScore;
    expect(up).toBeGreaterThan(95);
    expect(up).toBeLessThanOrEqual(100);
    expect(down).toBeCloseTo(-(up ?? 0), 6);

    const h1Only = deriveMetrics(snap({ priceChangePct: { h1: 25 } }), [], T0).momentumScore;
    expect(h1Only).toBeCloseTo(100 * Math.tanh(1), 6);

    const flat = deriveMetrics(snap({ priceChangePct: { m5: 0, h1: 0, h6: 0 } }), [], T0).momentumScore;
    expect(flat).toBe(0);
  });

  it('momentum ignores windows longer than the token has existed (they only measure the launch)', () => {
    const changes = { m5: 5, h1: 300, h6: 300 };
    const at = (ageMin: number) =>
      deriveMetrics(snap({ createdAt: T0 - ageMin * MIN, priceChangePct: changes }), [], T0).momentumScore;
    expect(at(3)).toBeNull(); // even m5 reaches back to the launch
    expect(at(20)).toBeCloseTo(100 * Math.tanh(0.5), 6); // m5 only
    expect(at(90)).toBeCloseTo((100 * (0.2 * Math.tanh(0.5) + 0.5 * Math.tanh(12))) / 0.7, 6); // m5 + h1
    expect(at(400)).toBeCloseTo(100 * (0.2 * Math.tanh(0.5) + 0.5 * Math.tanh(12) + 0.3 * Math.tanh(6)), 6);
  });

  it('volatility proxy is the dispersion of hour-scaled changes and needs two windows', () => {
    const m = deriveMetrics(snap({ priceChangePct: { m5: 1, h1: 10, h6: 24 } }), [], T0);
    const xs = [Math.sqrt(12), 10, 24 / Math.sqrt(6)];
    const mean = xs.reduce((a, b) => a + b) / 3;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / 3);
    expect(m.volatilityProxy).toBeCloseTo(sd, 9);

    expect(deriveMetrics(snap({ priceChangePct: { h1: 10 } }), [], T0).volatilityProxy).toBeNull();
  });

  it('classifies large-wallet flow relative to liquidity', () => {
    const flow = (volumeH1: number, trades: number, liquidityUsd: number | null) =>
      deriveMetrics(snap({ volumeUsd: { h1: volumeH1 }, txns: { h1: tx(trades, 0) }, liquidityUsd }), [], T0)
        .largeWalletFlow;

    expect(flow(20_000, 10, 50_000)).toBe('high'); // $2,000 ≥ max($1,500, $500)
    expect(flow(20_000, 10, 400_000)).toBe('normal'); // $2,000 < 1% of $400k
    expect(flow(20_000, 10, null)).toBe('high'); // falls back to the $1,500 floor
    expect(flow(1_000, 10, 50_000)).toBe('low'); // $100
    expect(flow(20_000, 4, 50_000)).toBeNull(); // too few trades to judge
  });

  it('volume/liquidity uses h1 for tokens under 2 h and h24 otherwise; Amihud needs $1k volume', () => {
    const base = { volumeUsd: { h1: 4000, h24: 30_000 }, liquidityUsd: 10_000, priceChangePct: { h1: 12 } };
    const young = deriveMetrics(snap({ ...base, createdAt: T0 - 90 * MIN }), [], T0);
    const old = deriveMetrics(snap({ ...base, createdAt: T0 - 5 * HOUR }), [], T0);
    expect(young.volumeToLiquidity).toBeCloseTo(0.4, 9);
    expect(old.volumeToLiquidity).toBeCloseTo(3, 9);
    expect(old.illiquidity).toBeCloseTo(12 / 0.004, 6);

    const thin = deriveMetrics(snap({ volumeUsd: { h1: 999 }, priceChangePct: { h1: 12 }, liquidityUsd: 0 }), [], T0);
    expect(thin.illiquidity).toBeNull();
    expect(thin.volumeToLiquidity).toBeNull();
  });
});

describe('toCardMetrics', () => {
  it('falls back to FDV for market cap and flags it', () => {
    const s = snap({ fdvUsd: 266_064, marketCapUsd: null, volumeUsd: { h24: 5000 } });
    const card = toCardMetrics(s, deriveMetrics(s, [], T0));
    expect(card.marketCapUsd).toBe(266_064);
    expect(card.mcIsFdv).toBe(true);
    expect(card.volumeUsd).toBe(5000);
    expect(card.volumeWindow).toBe('h24');
  });

  it('prefers real market cap and h1 volume, and passes unknowns through as null', () => {
    const s = snap({
      marketCapUsd: 1_000_000,
      fdvUsd: 2_000_000,
      volumeUsd: { h1: 1200, h24: 9000 },
      priceChangePct: { h1: -4 },
      holders: 321,
      createdAt: T0 - 30 * MIN,
    });
    const card = toCardMetrics(s, deriveMetrics(s, [], T0));
    expect(card).toEqual({
      priceUsd: null,
      marketCapUsd: 1_000_000,
      mcIsFdv: false,
      liquidityUsd: null,
      volumeUsd: 1200,
      volumeWindow: 'h1',
      txPerMin: null,
      buyPct: null,
      sellPct: null,
      holders: 321,
      holdersGrowthPct: null,
      priceChangeH1Pct: -4,
      ageMinutes: 30,
    });
  });

  it('has no volume window when no volume is known', () => {
    const s = snap();
    const card = toCardMetrics(s, deriveMetrics(s, [], T0));
    expect(card.volumeUsd).toBeNull();
    expect(card.volumeWindow).toBeNull();
    expect(card.marketCapUsd).toBeNull();
    expect(card.mcIsFdv).toBe(false);
  });
});
