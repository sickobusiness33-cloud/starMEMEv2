/**
 * HootRadar — shared domain contract between server and web.
 *
 * Rules that every module must respect:
 *  - Every number shown to a user comes from a real provider response or is
 *    derived from one. When a value is unknown it is `null` — never 0, never a
 *    guess. The UI renders `null` as "—" (with a reason when we have one).
 *  - Timestamps are epoch milliseconds (UTC).
 *  - Percentages are plain numbers (12.5 means 12.5%).
 */

/* ───────────────────────────── Chains ───────────────────────────── */

/** Known chain ids. Kept as `string` at the edges so new adapters can be added without touching this file. */
export type KnownChainId = 'solana' | 'ethereum' | 'base' | 'bsc';
export type ChainId = KnownChainId | (string & {});

export type ChainStatus = 'scanning' | 'degraded' | 'down' | 'idle';

export interface ChainInfo {
  id: ChainId;
  name: string; // "Solana"
  short: string; // "SOL"
  nativeSymbol: string; // "SOL" | "ETH" | "BNB"
  color: string; // accent used for the chain dot in the UI
  status: ChainStatus;
  lastScanAt: number | null;
  lastError: string | null;
  /** distinct tokens this chain produced in the last 24h */
  tokensSeen24h: number;
}

/* ─────────────────────────── Market data ─────────────────────────── */

export type TimeWindow = 'm5' | 'm15' | 'm30' | 'h1' | 'h6' | 'h24';

export interface TxCounts {
  buys: number | null;
  sells: number | null;
  /** unique buying wallets in the window (GeckoTerminal provides this, DexScreener does not) */
  buyers: number | null;
  sellers: number | null;
}

export interface TokenLink {
  type: 'website' | 'twitter' | 'telegram' | 'discord' | 'other';
  url: string;
  label?: string;
}

export interface TokenSecurity {
  mintAuthority: boolean | null; // true = mint authority still enabled (risk)
  freezeAuthority: boolean | null;
  honeypot: 'yes' | 'no' | 'unknown';
  devHoldingPct: number | null;
}

/** One normalized observation of a token, merged from one or more providers. */
export interface TokenSnapshot {
  chain: ChainId;
  address: string; // token (mint / contract) address, original casing
  symbol: string;
  name: string;
  pairAddress: string | null; // most liquid pool we know of
  dex: string | null;
  /**
   * Creation time (ms) of the pool named in `pairAddress`, the pool every per-window
   * figure (txns, volume, price change, liquidity) was measured on. It can be much
   * younger than the token (a launchpad coin that just graduated). Optional: absent
   * on snapshots stored before it existed; null when the provider did not report it.
   */
  pairCreatedAt?: number | null;
  /** provider whose figure `liquidityUsd` is ("geckoterminal" | "dexscreener"); null/absent when unknown */
  liquiditySource?: string | null;
  /**
   * true when the provider's reported liquidity was replaced by the pool's quote-backed
   * value (fake-priced or single-sided pool). Growth is never measured across such a switch.
   */
  liquidityAdjusted?: boolean;
  ts: number; // when this snapshot was observed
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: Partial<Record<TimeWindow, number | null>>;
  priceChangePct: Partial<Record<TimeWindow, number | null>>;
  txns: Partial<Record<TimeWindow, TxCounts>>;
  holders: number | null;
  top10HolderPct: number | null;
  /** token / pool creation time (ms). Prefer token creation, fall back to first pool creation. */
  createdAt: number | null;
  imageUrl: string | null;
  links: TokenLink[];
  security: TokenSecurity | null;
  /** providers that contributed to this snapshot, e.g. ["geckoterminal","dexscreener"] */
  sources: string[];
  /** true when the provider marks the listing as paid promotion (e.g. DexScreener boost) */
  boosted: boolean;
}

/** Features derived from the latest snapshot + recent history. Null = not computable from available data. */
export interface DerivedMetrics {
  ageMinutes: number | null;
  /** (buys+sells) per minute over the last 5 minutes */
  txPerMin: number | null;
  /** tx rate in m5 divided by average tx rate over h1 (1 = steady, 3 = 3x faster) */
  txAcceleration: number | null;
  /** volume rate in m5 divided by average volume rate over h1 */
  volumeAcceleration: number | null;
  /** buy share of transactions (0-100) in the shortest window with data */
  buyPct: number | null;
  sellPct: number | null;
  buySellWindow: TimeWindow | null;
  /** unique buyers in the last 5 minutes (null when provider has no wallet counts) */
  uniqueBuyersM5: number | null;
  /** unique-buyer rate in m5 vs average over h1 */
  buyerAcceleration: number | null;
  /** holder count change (%) between the oldest and newest snapshot we have within ~60 min */
  holdersGrowthPct: number | null;
  holdersGrowthWindowMin: number | null;
  /** liquidity change (%) across our own snapshot history within ~60 min */
  liquidityChangePct: number | null;
  /** -100..100 composite of price change across m5/h1/h6 */
  momentumScore: number | null;
  /** dispersion of price changes across windows; a crude realized-volatility proxy (pct points) */
  volatilityProxy: number | null;
  /** average buy size in USD over h1 (volume / tx count approximation) */
  avgTradeUsd: number | null;
  /**
   * Large-wallet flow proxy ("smart money" requires a labelled-wallet provider; we do not fake it).
   * 'high' when average trade size is unusually large relative to liquidity.
   */
  largeWalletFlow: 'high' | 'normal' | 'low' | null;
  /** h24 (or h1 for very young tokens) volume divided by liquidity */
  volumeToLiquidity: number | null;
  /** Amihud-style illiquidity: |price change h1| / (volume h1 in $M). Higher = thinner. */
  illiquidity: number | null;
}

/* ─────────────────────────── Detection ─────────────────────────── */

export type Severity = 'BREAKING' | 'ALERT' | 'WATCH';

export type SignalCode =
  | 'volume_surge'
  | 'tx_acceleration'
  | 'buyer_surge'
  | 'holder_growth'
  | 'liquidity_growth'
  | 'momentum'
  | 'buy_pressure'
  | 'large_wallet_flow'
  | 'social_attention'
  | 'fresh_launch';

export interface AnomalySignal {
  code: SignalCode;
  label: string; // short human label, e.g. "Volume 4.2x vs 1h avg"
  value: number | null;
  /** contribution to the anomaly score (0-100 scale, signals are summed then capped) */
  weight: number;
}

export interface Detection {
  score: number; // 0-100
  severity: Severity | null; // null = below WATCH threshold
  signals: AnomalySignal[];
  /** reasons the token was disqualified (too little liquidity, honeypot, ...) */
  rejected: string[];
  /**
   * Reasons the severity was capped below what the score alone would give
   * (e.g. BREAKING held at ALERT: thin market, concentrated holders, mint authority).
   * Absent or empty when nothing was capped.
   */
  caps?: string[];
}

export interface DetectionEvent {
  id: string;
  ts: number;
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  score: number;
  severity: Severity;
  signals: AnomalySignal[];
  articleId: string | null;
}

/* ───────────────────────────── Quant ───────────────────────────── */

export type QuantFamily =
  | 'momentum'
  | 'trend'
  | 'breakout'
  | 'mean_reversion'
  | 'volume'
  | 'volatility'
  | 'liquidity'
  | 'order_flow'
  | 'attention'
  | 'regime'
  | 'risk';

export interface QuantReference {
  label: string;
  url: string;
  kind: 'paper' | 'quantpedia' | 'book' | 'article';
}

/** A methodology described in our own words, with links to its public sources. No proprietary text is copied. */
export interface QuantMethodology {
  id: string;
  name: string;
  family: QuantFamily;
  summary: string; // 1-2 sentences, own words
  howItWorks: string[]; // 2-4 bullet points, own words
  /** which observable conditions make a token "resemble" this methodology */
  signature: string;
  cryptoAdaptation: string; // how we adapt a (usually equity/futures) idea to minute-scale DEX data
  horizon: string; // e.g. "minutes to hours"
  caveats: string[];
  references: QuantReference[];
}

export interface QuantFactor {
  feature: string; // e.g. "volumeAcceleration"
  label: string; // e.g. "Volume acceleration"
  value: number | null;
  /** 0-1 how much this feature satisfies the methodology's signature */
  fit: number;
  weight: number;
}

export interface QuantMatch {
  methodologyId: string;
  name: string;
  family: QuantFamily;
  score: number; // 0-100 similarity, NOT a probability of profit
  /** share of the methodology's features that had data (0-1). Low coverage caps the score. */
  coverage: number;
  rationale: string; // one sentence: "Current market conditions resemble ..."
  factors: QuantFactor[];
}

export interface MarketRegime {
  label: 'risk-on' | 'neutral' | 'risk-off' | 'unknown';
  /** % of tracked young tokens with positive h1 price change */
  breadthPct: number | null;
  /** median h1 price change across the tracked universe */
  medianH1ChangePct: number | null;
  sampleSize: number;
  computedAt: number;
}

export interface QuantResult {
  top: QuantMatch | null;
  matches: QuantMatch[]; // sorted desc, all methodologies with score > 0
  regime: MarketRegime;
  riskFlags: string[]; // e.g. "Mint authority enabled", "Liquidity under $10k"
  disclaimer: string;
}

/* ─────────────────────────── News ─────────────────────────── */

export interface CardMetrics {
  priceUsd: number | null;
  marketCapUsd: number | null; // falls back to FDV when MC unknown (flagged by mcIsFdv)
  mcIsFdv: boolean;
  liquidityUsd: number | null;
  volumeUsd: number | null;
  volumeWindow: TimeWindow | null; // which window volumeUsd refers to
  txPerMin: number | null;
  buyPct: number | null;
  sellPct: number | null;
  holders: number | null;
  holdersGrowthPct: number | null;
  priceChangeH1Pct: number | null;
  ageMinutes: number | null;
}

export interface PipelineTimings {
  detectedAt: number;
  analyzedAt: number;
  quantAt: number;
  writtenAt: number;
  publishedAt: number;
}

export interface NewsOutlook {
  bullish: string;
  neutral: string;
  risk: string;
}

export interface NewsArticle {
  id: string;
  createdAt: number;
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  severity: Severity;
  score: number;
  headline: string; // "BREAKING — $TOKEN" style is built by the UI; this is the descriptive headline
  lede: string; // 1-2 sentence news paragraph with real numbers
  aiLine: string; // one-line takeaway shown on the card
  whyItMatters: string[]; // exactly 3 bullets
  quantAnalysis: string;
  outlook: NewsOutlook;
  engine: 'claude' | 'rules';
  model: string | null;
  lang: 'es' | 'en';
  metrics: CardMetrics;
  signals: AnomalySignal[];
  quant: { top: QuantMatch | null; matches: QuantMatch[]; regime: MarketRegime; riskFlags: string[] };
  pipeline: PipelineTimings;
  links: {
    dexscreener: string | null;
    explorer: string | null;
    website: string | null;
    twitter: string | null;
    telegram: string | null;
  };
  /** an article about the same token supersedes an earlier one when the situation escalates */
  updateOf: string | null;
}

/* ─────────────────────────── Distribution ─────────────────────────── */

export type DistributionChannel = 'x' | 'telegram' | 'discord' | 'webhook';
export type DistributionStatus = 'ready' | 'queued' | 'sent' | 'failed' | 'skipped';

export interface DistributionItem {
  id: string;
  articleId: string;
  channel: DistributionChannel;
  /** channel-ready content: plain text for x/telegram (telegram uses HTML parse mode), JSON string for discord/webhook */
  payload: string;
  status: DistributionStatus;
  createdAt: number;
  sentAt: number | null;
  error: string | null;
}

/* ─────────────────────────── Radar ─────────────────────────── */

export type Freshness = 'LIVE' | 'RECENT' | 'OLD' | 'UNKNOWN';

export type IntelSourceType =
  | 'news'
  | 'article'
  | 'social'
  | 'blog'
  | 'forum'
  | 'community'
  | 'specialized'
  | 'official';

export interface IntelItem {
  id: string;
  title: string;
  url: string;
  sourceName: string; // e.g. "coindesk.com", "Hacker News", "/biz/"
  sourceType: IntelSourceType;
  provider: string; // which integration found it: "gdelt" | "hn" | "biz" | "claude-web" | "dexscreener" | ...
  publishedAt: number | null;
  freshness: Freshness; // LIVE <= 60 min, RECENT <= 24 h, OLD > 24 h
  /**
   * 'day' when the source only gave a calendar date (publishedAt is then that day's
   * 00:00 UTC): such an item is never LIVE. Absent = an exact timestamp.
   */
  publishedPrecision?: 'exact' | 'day';
  snippet: string | null;
  matchedOn: 'symbol' | 'name' | 'contract' | 'project';
}

export interface TokenRef {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  createdAt: number | null;
  imageUrl: string | null;
}

export type RadarStageId = 'resolve' | 'onchain' | 'holders' | 'quant' | 'web' | 'ai';
export type RadarStageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface RadarStage {
  id: RadarStageId;
  label: string;
  status: RadarStageStatus;
  message: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface RadarBrief {
  summary: string; // 2-3 sentences
  bullets: string[]; // 3-5
  outlook: NewsOutlook;
  engine: 'claude' | 'rules';
  model: string | null;
}

/** What one intel provider returned for a Radar search (ok=false: it failed or was not run, see `error`). */
export interface IntelProviderStatus {
  provider: string; // "gdelt" | "hn" | "biz" | "official" | "claude-web"
  ok: boolean;
  /** relevant items kept from this provider (0 when it failed) */
  count: number;
  error: string | null;
}

export interface UnavailableField {
  field: string; // e.g. "smartMoney"
  reason: string; // e.g. "Requires a labelled-wallet data provider (not configured)"
}

export interface RadarReport {
  id: string;
  query: string;
  createdAt: number;
  updatedAt: number;
  status: 'running' | 'done' | 'error' | 'not_found' | 'ambiguous';
  error: string | null;
  stages: RadarStage[];
  /** when a symbol matches several tokens we pick the most liquid and list the rest here */
  candidates: TokenRef[];
  token: TokenRef | null;
  snapshot: TokenSnapshot | null;
  metrics: DerivedMetrics | null;
  detection: Detection | null;
  quant: QuantResult | null;
  intel: IntelItem[];
  /** per-provider outcome of the web stage, in provider order; [] until the stage ran */
  providers?: IntelProviderStatus[];
  brief: RadarBrief | null;
  unavailable: UnavailableField[];
}

/* ─────────────────────────── Platform ─────────────────────────── */

export interface EngineState {
  status: 'starting' | 'active' | 'degraded';
  ai: 'claude' | 'rules';
  model: string | null;
  /** last error from the AI provider, if any (e.g. invalid key) */
  aiError: string | null;
}

export interface Stats {
  engine: EngineState;
  chainsScanning: number; // chains whose last scan succeeded within 2 min
  chainsTotal: number;
  tokensAnalyzed24h: number; // distinct tokens with >=1 snapshot in the last 24h
  anomalies24h: number; // detection events (any severity) in the last 24h
  breaking24h: number; // BREAKING events in the last 24h
  articles24h: number;
  lastScanAt: number | null;
  startedAt: number;
  chains: ChainInfo[];
  distribution: { channels: DistributionChannel[]; sent24h: number };
}

export interface FeedResponse {
  articles: NewsArticle[];
  nextBefore: number | null;
}

export interface ArticleResponse {
  article: NewsArticle;
  distribution: DistributionItem[];
  related: DetectionEvent[]; // earlier detections of the same token
}

export interface QuantLibraryResponse {
  methodologies: QuantMethodology[];
  disclaimer: string;
  sourcePolicy: string; // how we use Quantpedia / papers (no scraping, own words, links only)
}

export interface QuantLeader {
  methodologyId: string;
  tokens: Array<TokenRef & { score: number; articleId: string | null }>;
}

export interface QuantLeadersResponse {
  regime: MarketRegime;
  leaders: QuantLeader[];
  computedAt: number;
}

/** Server-Sent Events on GET /api/stream. `event:` field equals `type`. */
export type StreamEvent =
  | { type: 'hello'; stats: Stats; articles: NewsArticle[]; events: DetectionEvent[] }
  | { type: 'article'; article: NewsArticle }
  | { type: 'detection'; event: DetectionEvent }
  | { type: 'stats'; stats: Stats };

/** Server-Sent Events on GET /api/radar/:id/stream */
export type RadarStreamEvent =
  | { type: 'report'; report: RadarReport } // full report, sent on every meaningful change
  | { type: 'end'; report: RadarReport };

export const FRESHNESS_LIVE_MS = 60 * 60 * 1000;
export const FRESHNESS_RECENT_MS = 24 * 60 * 60 * 1000;

export const QUANT_DISCLAIMER =
  'Quant Match measures how closely current on-chain conditions resemble the conditions a published methodology looks for. It is a similarity score, not a forecast, not a probability of profit and not investment advice.';
