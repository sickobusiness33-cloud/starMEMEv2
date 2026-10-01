import type { QuantMethodology, QuantReference } from '../../../shared/types.js';

/**
 * Pluggable methodology provider. The built-in library below is written in our
 * own words; a licensed feed (e.g. a Quantpedia Pro/API subscription) can be
 * wired in by implementing this interface.
 */
export interface QuantSource {
  name: string;
  load(): Promise<QuantMethodology[]>;
}

export const SOURCE_POLICY =
  'HootRadar uses Quantpedia as a research pointer only and strictly respects its terms of use, licences and copyright: ' +
  'we do not scrape it and we do not copy its text. Every methodology in this library is described in our own words from ' +
  'general academic knowledge and cites the original peer-reviewed paper (DOI link, or the public working-paper page when ' +
  'the publisher blocks automated checks). A public Quantpedia strategy page is linked only where we verified, with a single ' +
  'lightweight request, that the URL resolves; otherwise the paper link stands alone. Reference links were last checked on ' +
  '1 October 2026. A licensed Quantpedia Pro/API feed can be plugged in through the QuantSource interface ' +
  '({ name, load(): Promise<QuantMethodology[]> }) without changing how matching works.';

/* ─────────── references (each URL verified to end in HTTP 200 on 2026-10-01) ─────────── */

const paper = (label: string, url: string): QuantReference => ({ label, url, kind: 'paper' });
const quantpedia = (label: string, url: string): QuantReference => ({ label, url, kind: 'quantpedia' });

const REF = {
  moskowitzOoiPedersen2012: paper(
    'Moskowitz, Ooi & Pedersen (2012), "Time Series Momentum", Journal of Financial Economics',
    'https://doi.org/10.1016/j.jfineco.2011.11.003',
  ),
  liuTsyvinskiWu: paper(
    'Liu, Tsyvinski & Wu, "Common Risk Factors in Cryptocurrency", NBER Working Paper 25882 (published in the Journal of Finance, 2022)',
    'https://www.nber.org/papers/w25882',
  ),
  liuTsyvinski: paper(
    'Liu & Tsyvinski, "Risks and Returns of Cryptocurrency", NBER Working Paper 24877 (published in the Review of Financial Studies, 2021)',
    'https://www.nber.org/papers/w24877',
  ),
  lehmann: paper(
    'Lehmann, "Fads, Martingales, and Market Efficiency", NBER Working Paper 2533 (published in the Quarterly Journal of Economics, 1990)',
    'https://www.nber.org/papers/w2533',
  ),
  kanielOzoguzStarks2012: paper(
    'Kaniel, Ozoguz & Starks (2012), "The High Volume Return Premium: Cross-Country Evidence", Journal of Financial Economics',
    'https://doi.org/10.1016/j.jfineco.2011.08.012',
  ),
  moreiraMuir: paper(
    'Moreira & Muir, "Volatility-Managed Portfolios", NBER Working Paper 22208 (published in the Journal of Finance, 2017)',
    'https://www.nber.org/papers/w22208',
  ),
  barrosoSantaClara2015: paper(
    'Barroso & Santa-Clara (2015), "Momentum Has Its Moments", Journal of Financial Economics',
    'https://doi.org/10.1016/j.jfineco.2014.11.010',
  ),
  amihud2002: paper(
    'Amihud (2002), "Illiquidity and Stock Returns: Cross-Section and Time-Series Effects", Journal of Financial Markets',
    'https://doi.org/10.1016/S1386-4181(01)00024-6',
  ),
  chordiaSubrahmanyam2004: paper(
    'Chordia & Subrahmanyam (2004), "Order Imbalance and Individual Stock Returns: Theory and Evidence", Journal of Financial Economics',
    'https://doi.org/10.1016/S0304-405X(03)00175-2',
  ),
  urquhart2018: paper(
    'Urquhart (2018), "What Causes the Attention of Bitcoin?", Economics Letters',
    'https://doi.org/10.1016/j.econlet.2018.02.017',
  ),
  danielMoskowitz2016: paper(
    'Daniel & Moskowitz (2016), "Momentum Crashes", Journal of Financial Economics',
    'https://doi.org/10.1016/j.jfineco.2015.12.002',
  ),
  qpTimeSeriesMomentum: quantpedia(
    'Quantpedia public strategy page: time-series momentum',
    'https://quantpedia.com/strategies/time-series-momentum-effect',
  ),
  qpShortTermReversal: quantpedia(
    'Quantpedia public strategy page: short-term reversal in stocks',
    'https://quantpedia.com/strategies/short-term-reversal-in-stocks',
  ),
  qpTrendFollowingStocks: quantpedia(
    'Quantpedia public strategy page: trend following in stocks',
    'https://quantpedia.com/strategies/trend-following-effect-in-stocks',
  ),
  qpAssetClassTrend: quantpedia(
    'Quantpedia public strategy page: asset-class trend following',
    'https://quantpedia.com/strategies/asset-class-trend-following',
  ),
} satisfies Record<string, QuantReference>;

/* ───────────────────────────── methodologies ───────────────────────────── */

export const METHODOLOGIES: QuantMethodology[] = [
  {
    id: 'ts-momentum',
    name: 'Time-series momentum',
    family: 'momentum',
    summary:
      "An asset's own past return tends to persist: markets that have risen over a lookback window keep drifting up on average and fallers keep falling. It compares each asset only with its own history, not with its peers.",
    howItWorks: [
      'Measure each market’s excess return over a fixed lookback (the reference study uses roughly a year of history across liquid futures and forwards).',
      'Hold long when that return is positive and short when it is negative, one market at a time.',
      'Scale every position by the inverse of its recent volatility so each market contributes a similar amount of risk.',
      'Moskowitz, Ooi & Pedersen (2012) find the effect across equity-index, bond, currency and commodity markets, with a partial reversal at longer horizons.',
    ],
    signature:
      'Positive and mutually confirming 1h and 6h price changes, a strong composite momentum score and no sharp reversal in the last 5 minutes.',
    cryptoAdaptation:
      'The year-long lookback is compressed into the 1h and 6h windows DEX aggregators report, and the 5m window serves as confirmation that the move has not already flipped. Only the long side is scored because most new DEX tokens cannot be shorted; volatility scaling is left to the volatility-managed overlay. Tokens younger than about 45 minutes are not scored at all: providers report their whole life in every window, so there is no lookback to measure.',
    horizon: 'Minutes to a few hours',
    caveats: [
      'The evidence comes from liquid futures over months; nothing guarantees it survives compression to minute-scale memecoin data.',
      'A token a few hours old has almost no lookback history, and a single large trade can define a whole window.',
      'Momentum is prone to abrupt crashes when trends turn (Daniel & Moskowitz, 2016).',
      'Survivorship: tokens that already collapsed drop out of the tracked universe, flattering any trend measured on the survivors.',
    ],
    references: [REF.moskowitzOoiPedersen2012, REF.qpTimeSeriesMomentum],
  },
  {
    id: 'crypto-size-momentum',
    name: 'Crypto size & momentum factors',
    family: 'momentum',
    summary:
      'A handful of crypto-specific factors — the market, coin size and recent performance — explain much of the cross-section of cryptocurrency returns: smaller coins and recent winners have historically earned higher average returns.',
    howItWorks: [
      'Sort coins by market capitalisation and by their return over the past few weeks.',
      'Build long-short portfolios: small minus large coins for size, recent winners minus recent losers for momentum.',
      'Liu, Tsyvinski & Wu show these factors price the cross-section of coin returns; Liu & Tsyvinski find crypto returns barely load on stock, currency or commodity factors but do respond to crypto momentum and investor attention.',
    ],
    signature:
      'A small but tradable market capitalisation combined with a positive 24h price change and a positive composite momentum score.',
    cryptoAdaptation:
      'The original factors are long-short portfolios rebalanced weekly over established coins above a minimum size. We keep the two characteristics — small size and positive recent return — but measure them on a single new DEX token (market cap, or FDV when market cap is unknown; 24h change; composite momentum) and require pool liquidity as a stand-in for the minimum-size screen. It is a characteristic match, not a portfolio.',
    horizon: 'Hours to days',
    caveats: [
      'The studies cover listed coins with years of history; launch-day DEX tokens are a different population.',
      'Small size often means "can be drained": part of the size premium is compensation for liquidity and failure risk.',
      'A new token’s market cap is frequently its FDV, which overstates value when supply is not circulating.',
      'Matching one token loses the diversification that makes a factor portfolio work; what remains is idiosyncratic risk.',
    ],
    references: [REF.liuTsyvinskiWu, REF.liuTsyvinski],
  },
  {
    id: 'short-term-reversal',
    name: 'Short-term reversal',
    family: 'mean_reversion',
    summary:
      'Over very short horizons the biggest winners tend to give back part of their gains and the biggest losers tend to bounce, a pattern usually attributed to temporary price pressure and liquidity provision rather than to news.',
    howItWorks: [
      'Rank assets by their return over the past week or month.',
      'Buy the recent losers, sell the recent winners, hold briefly and re-rank.',
      'Jegadeesh (1990) and Lehmann (1990) documented the monthly and weekly versions in US equities; the profits are highly sensitive to trading costs.',
    ],
    signature:
      'An extreme 1h move, a 5-minute counter-move against it, and transaction and volume pace slowing relative to the hourly average (exhaustion).',
    cryptoAdaptation:
      'The weekly or monthly ranking becomes the 1h window and the test is applied within one token rather than across a portfolio: an extreme 1h move is the overextended leg, a 5m move in the opposite direction is the first sign of reversion, and a decelerating transaction and volume rate suggests the impulse is fading.',
    horizon: 'Minutes to about an hour',
    caveats: [
      'A memecoin that drops 60% is often not overreacting: rug pulls and developer exits do not bounce.',
      'Equity reversal profits shrink sharply after costs; DEX swap fees, slippage and MEV are far larger.',
      'Buying the low of a liquidity-trap token is the classic way to lose the entire position.',
    ],
    references: [REF.lehmann, REF.qpShortTermReversal],
  },
  {
    id: 'trend-following',
    name: 'Trend following',
    family: 'trend',
    summary:
      'Join established price trends across several horizons and stay with them until they end. Trend following has produced positive average returns across asset classes over very long samples, with its best results in extended moves.',
    howItWorks: [
      'Measure trend direction over several lookbacks (for example 1, 3 and 12 months) and combine the signals.',
      'Hold long in up-trends and short in down-trends, sizing each position by its volatility.',
      'Hurst, Ooi & Pedersen (2017) extend the evidence to more than a century of data across dozens of markets; it is closely related to time-series momentum.',
    ],
    signature:
      'Price rising on the 5m, 1h and 6h windows at once, the advance already under way before the last hour, and consistent moves across horizons rather than one spike.',
    cryptoAdaptation:
      'The multiple lookbacks become the 5m, 1h and 6h windows. Because most new DEX tokens cannot be shorted, only up-trends count; a down-trend maps to "no position" and is handled by the risk overlay. We favour advances that build over time (a positive change from 6h ago to 1h ago, low dispersion across horizons) over single-candle spikes, which in memecoins are often one buyer. As with time-series momentum, a window longer than the token’s life is treated as missing.',
    horizon: 'One to several hours',
    caveats: [
      'Trend signals need history; for a token younger than six hours the 6h window is truncated and inflated by the launch.',
      'In thin pools a handful of wallets can manufacture a trend.',
      'Trend followers lose in choppy markets and give back gains at turning points.',
    ],
    references: [REF.qpTrendFollowingStocks, REF.moskowitzOoiPedersen2012],
  },
  {
    id: 'volume-breakout',
    name: 'Volume breakout (high-volume return premium)',
    family: 'breakout',
    summary:
      'Unusually heavy trading draws attention to an asset and has been followed by higher subsequent returns. Combined with rising price, a volume shock marks a breakout that pulls in new participants.',
    howItWorks: [
      'Compare an asset’s recent volume with its own normal volume over a reference window.',
      'Assets with extreme volume shocks tend to outperform over the following weeks, while unusually quiet assets tend to lag.',
      'Gervais, Kaniel & Mingelgrin (2001) introduced the effect for US stocks; Kaniel, Ozoguz & Starks (2012) find it in most international markets.',
    ],
    signature:
      '5-minute volume running well above its hourly pace, transactions accelerating, and price rising on both the 5m and 1h windows.',
    cryptoAdaptation:
      'An abnormal-volume day becomes the 5m volume rate divided by the average rate over the last hour, cross-checked with transaction acceleration so one whale trade does not count as a crowd. Price must confirm on 5m and 1h, because a volume spike into falling price is distribution, not a breakout.',
    horizon: 'Minutes to hours',
    caveats: [
      'Wash trading inflates DEX volume cheaply; volume far above pool liquidity is suspicious.',
      'The original premium is measured over weeks after a daily volume shock; persistence at minute scale is unproven.',
      'Paid promotion can produce volume bursts that fade as soon as the campaign ends.',
    ],
    references: [REF.kanielOzoguzStarks2012],
  },
  {
    id: 'volatility-managed',
    name: 'Volatility-managed exposure',
    family: 'volatility',
    summary:
      'Scaling exposure inversely to recent realised volatility — taking less risk when markets are turbulent — improves risk-adjusted returns, because volatility spikes are not rewarded with proportionally higher returns.',
    howItWorks: [
      'Estimate recent realised variance (the reference study uses the previous month of daily returns).',
      'Scale the position by a constant divided by that variance, so exposure falls after turbulent periods and rises after calm ones.',
      'Moreira & Muir (2017) show the overlay raises Sharpe ratios for several equity factors; Barroso & Santa-Clara (2015) show the same scaling removes most of momentum’s crash risk.',
    ],
    signature:
      'A high realised-volatility proxy, a large 5-minute swing and a large 1h move in either direction. A strong match means exposure should be scaled DOWN.',
    cryptoAdaptation:
      'With no tick-level return series, realised volatility is approximated by the dispersion of the 5m, 1h and 6h changes after rescaling them to a common one-hour horizon, plus the size of the latest swings. This is a risk overlay: it never says "buy"; it says how much less risk a disciplined position would carry right now.',
    horizon: 'Continuous overlay, re-evaluated on every refresh',
    caveats: [
      'The volatility proxy is crude: three windows are not a return series.',
      'Memecoin volatility is so high that an equity-style volatility target would imply near-zero exposure most of the time.',
      'A calm reading on a token only minutes old reflects missing data, not safety.',
    ],
    references: [REF.moreiraMuir, REF.barrosoSantaClara2015],
  },
  {
    id: 'amihud-illiquidity',
    name: 'Amihud illiquidity',
    family: 'liquidity',
    summary:
      'Price impact per dollar traded measures how illiquid an asset is. Illiquid assets have historically earned a premium as compensation, and market-wide illiquidity shocks push prices down.',
    howItWorks: [
      'For each day, divide the absolute return by the dollar volume traded, then average over a long window.',
      'A higher value means each dollar of trading moves the price more — a thinner market.',
      'Amihud (2002) shows expected stock returns rise with this measure, both across stocks and over time.',
    ],
    signature:
      'A large 1h price move per million dollars of 1h volume (high Amihud ratio) in a pool with little liquidity.',
    cryptoAdaptation:
      'The ratio is computed on a single 1h window (absolute 1h change divided by 1h volume in $M) and paired with the pool liquidity reported by the DEX. Here a high reading is first a warning about price impact and exit risk; any "premium" is compensation for the real possibility of not being able to sell.',
    horizon: 'Hours',
    caveats: [
      'One window is a noisy estimate; the original averages hundreds of daily observations.',
      'A liquidity trap looks exactly like a high-premium opportunity until the pool is pulled.',
      'Unless liquidity is locked or burned, the deployer can remove it in one transaction.',
    ],
    references: [REF.amihud2002],
  },
  {
    id: 'order-flow-imbalance',
    name: 'Order-flow imbalance',
    family: 'order_flow',
    summary:
      'When buyer-initiated trades persistently outnumber seller-initiated ones, or the reverse, prices move in the direction of the imbalance, and the imbalance itself tends to persist.',
    howItWorks: [
      'Classify trades as buyer- or seller-initiated and compute the net imbalance over an interval.',
      'Positive imbalance coincides with rising prices; because imbalances are persistent, the current imbalance carries information about the next period.',
      'Chordia & Subrahmanyam (2004) document both the same-period and the predictive relation for individual US stocks.',
    ],
    signature:
      'Buyers clearly outnumbering sellers, enough trades per minute for the split to mean something, and the 5m price change moving up with the imbalance.',
    cryptoAdaptation:
      'DEX swaps are unambiguously buys or sells, so the imbalance is the buy share of transactions in the shortest window with enough trades. We require a meaningful trade rate and check that price confirms the imbalance. Only buy-side imbalance is scored as a setup, because new DEX tokens can rarely be shorted; heavy selling feeds the risk overlay instead.',
    horizon: 'Minutes',
    caveats: [
      'Transaction counts are not volume: many tiny bot buys can outnumber a few large sells.',
      'Bots split orders and sandwich trades, which distorts the counts.',
      'The paper’s predictive horizon is daily; persistence at minute scale is assumed, not proven.',
    ],
    references: [REF.chordiaSubrahmanyam2004],
  },
  {
    id: 'investor-attention',
    name: 'Investor attention',
    family: 'attention',
    summary:
      'Assets that suddenly capture retail attention see buying pressure and higher short-term prices that partly reverse later; attention is a demand shock, not information about value.',
    howItWorks: [
      'Measure attention directly — Da, Engelberg & Gao (2011) use search-engine query volume — rather than through indirect proxies such as news counts or turnover.',
      'A jump in attention is followed by higher prices over the next weeks and a partial reversal afterwards.',
      'For crypto, Liu & Tsyvinski find attention measures predict coin returns, and Urquhart (2018) studies what drives attention to Bitcoin.',
    ],
    signature:
      'Mentions in public news and forums, a burst of new unique buyers relative to the hourly pace, a growing holder count and paid promotion.',
    cryptoAdaptation:
      'Search-volume data is replaced with what can be observed within minutes: mentions counted from public sources, unique-buyer acceleration, holder growth across our own snapshots, and DexScreener boosts — which are purchased attention and are treated as such.',
    horizon: 'Minutes to hours',
    caveats: [
      'Attention can be bought (boosts, paid callers, bot-generated posts), and bought attention tends to fade fastest.',
      'In the literature attention-driven price pressure is followed by reversal; it is not a sign of value.',
      'Counting mentions in a few public sources misses private channels such as Telegram and Discord groups.',
    ],
    references: [REF.liuTsyvinski, REF.urquhart2018],
  },
  {
    id: 'regime-filter',
    name: 'Market regime filter',
    family: 'regime',
    summary:
      'A simple trend filter — hold risky assets only while they trade above a long moving average, otherwise step aside — has historically cut drawdowns substantially while keeping most of the return.',
    howItWorks: [
      'Compare each asset’s price with its long-run moving average (the original rule uses about ten months of monthly prices).',
      'Hold the asset while price is above the average; move to cash when it falls below.',
      'Faber (2007) popularised the rule for tactical asset allocation; Daniel & Moskowitz (2016) show momentum crashes cluster in identifiable market states.',
    ],
    signature:
      'A risk-on backdrop (most tracked tokens up over 1h and a positive median 1h change), the token itself above its price six hours ago and outperforming the median token.',
    cryptoAdaptation:
      'The "market" is the universe of young tokens HootRadar tracks: breadth is the share with a positive 1h change, and the regime is risk-on only when breadth and the median agree; tokens younger than 45 minutes are left out because their "1h" change is really their whole life. The moving-average test becomes the token’s 6h change — is it above where it traded six hours ago? A match means the backdrop permits risk, not that the token will rise.',
    horizon: 'Hours',
    caveats: [
      'The tracked universe is newly launched tokens, which carries strong launch and survivorship bias.',
      'Breadth measured on a few dozen tokens moves quickly and can flip within an hour.',
      'With fewer than 12 eligible tokens the regime is reported as unknown rather than guessed.',
    ],
    references: [REF.qpAssetClassTrend, REF.danielMoskowitz2016],
  },
  {
    id: 'risk-overlay',
    name: 'Drawdown & position-sizing overlay',
    family: 'risk',
    summary:
      'Rules that cut exposure as drawdowns deepen and size positions to what can be lost protect capital when markets or strategies break; for momentum-style strategies, crash risk is concentrated and partly predictable.',
    howItWorks: [
      'Track the decline from the recent peak and reduce position size as it deepens; Grossman & Zhou (1993) derive optimal investing under a maximum-drawdown constraint.',
      'Size each position so that losing all of it is survivable.',
      'Daniel & Moskowitz (2016) and Barroso & Santa-Clara (2015) show that scaling momentum exposure by forecast risk avoids most of its worst crashes.',
    ],
    signature:
      'A deep drawdown on any window (worst of the 1h, 6h and 24h changes), liquidity leaving the pool, sellers dominating transactions, concentrated holders and security red flags.',
    cryptoAdaptation:
      'Without a full price path, drawdown is proxied by the worst cumulative change across the 1h, 6h and 24h windows, and DEX-specific structural risks that equity overlays never face are added: liquidity being withdrawn, mint or freeze authority still enabled, unknown honeypot status, a large developer stake and holder concentration. A strong match means position size should be minimal or zero.',
    horizon: 'Continuous overlay, re-evaluated on every refresh',
    caveats: [
      'Security checks come from a third-party provider and can be stale or incomplete.',
      'On some chains holder concentration counts pool and burn addresses as holders.',
      'A low score does not make a token safe: team intent and hidden contract logic are invisible to these checks.',
    ],
    references: [REF.danielMoskowitz2016, REF.barrosoSantaClara2015],
  },
];

/** The built-in library exposed as a QuantSource, so callers can treat it like any other feed. */
export const BUILTIN_QUANT_SOURCE: QuantSource = {
  name: 'hootradar-builtin',
  load: async () => METHODOLOGIES,
};
