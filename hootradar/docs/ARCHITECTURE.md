# HootRadar — Architecture & module contracts

HootRadar is a real-time crypto intelligence newsroom. It answers one question:
**"What is happening in crypto RIGHT NOW?"**

```
BLOCKCHAINS → DETECT → ANALYZE → QUANT → AI WRITE → PUBLISH (LIVE) → DISTRIBUTION QUEUE
```

Independent project: its own backend (Node 22 + TypeScript + Fastify), database
(SQLite through the built-in `node:sqlite`), AI layer (Claude via `@anthropic-ai/sdk`,
with a deterministic rules writer as fallback) and frontend (React 19 + Vite).

## Non-negotiable principles

1. **No fake data.** Every number displayed comes from a provider response or is
   derived from one. Unknown = `null` → UI shows "—". No placeholder numbers, no
   simulated counters, no demo seed data. Header stats come from the database.
2. **Honest AI.** The header says which engine wrote the news (Claude model or
   rules). Articles never claim price will rise; outlook always has bull / neutral / risk.
3. **Quant = similarity, not prediction.** Always ship `QUANT_DISCLAIMER`.
4. **No automatic trading or financial transactions.** Distribution only publishes text.
5. **Respect providers.** Per-host rate limiters, timeouts, caching, a descriptive
   User-Agent. No scraping of Quantpedia — methodologies are written in our own
   words with links to the public Quantpedia page and the original paper.
   (Google News RSS is excluded: its terms forbid non-personal use.)
6. **Never crash the loop.** Every provider call is wrapped; failures degrade one
   chain/source and are surfaced in `ChainInfo.status/lastError`.

## Data providers (all free, no key required)

| Provider | Used for | Limit we enforce |
|---|---|---|
| GeckoTerminal `api.geckoterminal.com/api/v2` | `networks/{net}/new_pools` discovery (all chains, polled every 55 s: the CDN caches it 60 s), `tokens/{addr}/info` (holders, top-10 %, mint/freeze authority, honeypot), `tokens/{addr}/pools` lookup + unique-wallet counts on enrichment | 25 req/min global |
| DexScreener `api.dexscreener.com` | `tokens/v1/{chain}/{a,b,…≤30}` batch refresh, `latest/dex/search?q=` (Radar symbol search), `token-profiles/latest/v1` + `token-boosts/latest/v1` (discovery; boosts are paid promotion → `boosted=true`) | 250/min for pairs/tokens/search, 55/min for profiles/boosts |
| pump.fun `frontend-api-v3.pump.fun/coins?sort=created_timestamp` | Solana newest launches | 30/min |
| GDELT DOC 2.0 `api.gdeltproject.org/api/v2/doc/doc` | news/articles mentions (Radar) | 1 request / 5.5 s (serialized) |
| HN Algolia `hn.algolia.com/api/v1/search_by_date` | tech community mentions (Radar) | 60/min |
| 4chan `a.4cdn.org/biz/catalog.json` | public crypto forum mentions (Radar). Cache 60 s | 1/sec |
| Claude `web_search_20260209` (optional, needs `ANTHROPIC_API_KEY`) | broad web/social research for Radar with publish dates | per request `max_uses: 5` |

Real fixture responses for every provider live in `server/test/fixtures/` — parse them in tests.

### Provider field notes (verified against fixtures)
- GeckoTerminal pool `attributes`: `pool_created_at` ISO, `fdv_usd`, `market_cap_usd` (often null),
  `reserve_in_usd` (= liquidity), `base_token_price_usd`, `price_change_percentage.{m5,m15,m30,h1,h6,h24}`,
  `transactions.{m5,m15,m30,h1,h6,h24}.{buys,sells,buyers,sellers}`, `volume_usd.{…}`. All numbers are strings.
  `relationships.base_token.data.id` = `"{network}_{address}"`, `relationships.dex.data.id` (e.g. `pump-fun`).
  The *base token* is the new token, except when the base is a well-known quote (SOL/WETH/WBNB/USDC/USDT) — then use the quote token.
  Pool `name` is "SYMBOL / QUOTE". Token name/symbol need `include=base_token` (`?include=base_token,quote_token`) → `included[]`.
- GeckoTerminal token info: `holders.count`, `holders.distribution_percentage.top_10` (string), `mint_authority` ("yes"/"no"), `freeze_authority`, `is_honeypot` ("yes"/"no"/"unknown"), `developer_holding_percentage`, `websites[]`, `twitter_handle`, `telegram_handle`, `discord_url`, `image_url`.
- DexScreener pair: `chainId`, `pairAddress`, `baseToken.{address,name,symbol}`, `priceUsd` (string), `txns.{m5,h1,h6,h24}.{buys,sells}`, `volume.{m5,h1,h6,h24}`, `priceChange.{m5,h1,h6,h24}`, `liquidity.usd`, `fdv`, `marketCap`, `pairCreatedAt` (ms), `info.{imageUrl,websites[],socials[]}`, `boosts.active`.
- pump.fun coin: `mint`, `name`, `symbol`, `created_timestamp` (ms), `usd_market_cap`/`market_cap_usd`, `image_uri`, `twitter`, `telegram`, `website`, `complete` (graduated), `reply_count`.

## Directory layout

```
hootradar/
  shared/types.ts            ← THE domain contract (server + web). Do not fork types.
  server/src/
    config.ts                env → AppConfig (done)
    log.ts                   logger(scope), errMsg(e) (done)
    engine/bus.ts            typed in-process event bus (done)
    chains/types.ts          ChainAdapter / ChainConfig contract (done)
    net/http.ts              fetchJson/fetchText + per-key rate limiters + TTL cache
    sources/geckoterminal.ts sources/dexscreener.ts sources/pumpfun.ts sources/merge.ts
    chains/configs.ts chains/adapter.ts chains/registry.ts
    db/db.ts                 node:sqlite schema + repository (class Db)
    engine/metrics.ts engine/anomaly.ts engine/scanner.ts engine/pipeline.ts engine/stats.ts
    quant/library.ts quant/matcher.ts quant/regime.ts quant/leaders.ts
    ai/claude.ts ai/newswriter.ts ai/rules-writer.ts ai/brief.ts ai/web-research.ts ai/format.ts
    distribution/formats.ts distribution/queue.ts
    research/freshness.ts research/intel/{gdelt,hn,biz,official,index}.ts research/radar.ts
    http/server.ts http/sse.ts
    index.ts                 bootstrap & graceful shutdown
  server/test/*.test.ts      vitest; fixtures in server/test/fixtures
  web/                       React app (see "Frontend")
```

Imports of shared types from server code: `import type { … } from '../../../shared/types.js'`
(adjust depth). Use `.js` suffixes in relative imports (ESM, bundler resolution).

## Module contracts (exact exports)

### net/http.ts
```ts
export class HttpError extends Error { status: number; url: string }
export interface FetchOpts { timeoutMs?: number /*8000, per attempt once a slot is granted*/; retries?: number /*1, only for 429/5xx/network*/; headers?: Record<string,string>; limiter?: string /* key of a registered limiter */; cacheTtlMs?: number; notFoundTtlMs?: number /* remember 404s */; maxPauseWaitMs?: number /* fail fast during a 429 pause */; maxQueueMs?: number /* default 60 s */; signal?: AbortSignal }
export class RequestQueueError extends Error {}      // no limiter slot in time (queue full / wait too long); the provider was never asked
export class RequestCancelledError extends Error {}  // the caller's signal fired; queued requests leave the queue
export function registerLimiter(key: string, opts: { perMinute: number; minIntervalMs?: number; maxQueue?: number; group?: string }): void
export type Lane = 'scan' | 'radar'; export function laneLimiter(provider: string, lane?: Lane): string
export async function fetchJson<T = unknown>(url: string, opts?: FetchOpts): Promise<T>
export async function fetchText(url: string, opts?: FetchOpts): Promise<string>
```
Default User-Agent `HootRadar/0.1 (+crypto intelligence newsroom)`. 429 honours `retry-after`.
Limiter = FIFO token bucket (burst = 10% of perMinute unless `burst` is set; any 60 s window stays within perMinute). A request waits at most `maxQueueMs` (default 60 s) for a slot and leaves the
queue when its caller's signal fires, so the request timeout plus the queue wait bound its total time;
queues are capped (`maxQueue`). Cache keyed by URL; a shared cached request is cancelled only when every caller gave up.
Pre-registered limiters: `geckoterminal` 20/min (scanner) + `geckoterminal-radar` 6/min burst 3 (one search's top-pool + token-info calls start together), `dexscreener` 220/min +
`dexscreener-radar` 30/min (lanes of one group: a 429 pauses both; Radar can never starve the scanner),
`dexscreener-meta` 55/min, `pumpfun` 30/min, `gdelt` 10/min minInterval 5500ms, `hn` 60/min, `biz` 30/min minInterval 1000ms.

### sources/*
```ts
// geckoterminal.ts
export async function gtNewPools(network: string, chain: ChainId): Promise<TokenSnapshot[]>   // uses include=base_token,quote_token
export async function gtTokenInfo(network: string, address: string): Promise<TokenEnrichment | null>
export async function gtTokenTopPool(network: string, chain: ChainId, address: string): Promise<TokenSnapshot | null>
// dexscreener.ts
export async function dsTokens(dsChainId: string, chain: ChainId, addresses: string[]): Promise<TokenSnapshot[]> // chunks of 30; picks most liquid pair per token
export async function dsSearch(query: string): Promise<TokenSnapshot[]>   // one snapshot per (chain,address), best-liquidity pair, all chains (caller filters)
export async function dsLatestListings(): Promise<Array<{ dsChainId: string; address: string; boosted: boolean; links: TokenLink[]; imageUrl: string | null }>>
// pumpfun.ts
export async function pumpNewest(limit?: number): Promise<TokenSnapshot[]>  // chain 'solana'
// merge.ts
export function mergeSnapshots(base: TokenSnapshot, extra: Partial<TokenSnapshot>): TokenSnapshot // same pool only: non-null wins over null; union sources/links; keep earliest createdAt
export function mergeAcrossPools(base: TokenSnapshot, extra: TokenSnapshot, prefer?: 'extra' | 'deeper'): TokenSnapshot // different pools: one pool kept whole, the other adds token-level facts only
export function emptySnapshot(chain: ChainId, address: string, ts: number): TokenSnapshot
```
All parse functions are pure and exported separately (`parseGtPools(json, chain)`, `parseDsPairs(json, chain)`, …) so tests run against fixtures without network.
Provenance on every snapshot: `pairCreatedAt` (the measured pool's creation), `liquiditySource` and
`liquidityAdjusted` (quote-backed replacement). Per-window figures never mix two pools.

### chains/*
```ts
export const CHAIN_CONFIGS: Record<KnownChainId, ChainConfig>
export function createAdapter(config: ChainConfig): ChainAdapter   // generic Gecko+DexScreener adapter
export function createChainAdapters(ids: KnownChainId[]): ChainAdapter[] // solana adapter adds pump.fun to discover()
```
`discover()` = GT new_pools (+ pump.fun newest for Solana, + DexScreener latest listings for this chain),
each source within its own 12 s deadline (a paused GeckoTerminal is skipped for the cycle), then a DexScreener
batch refresh of the discovered addresses: its main pool replaces the discovered pool whole.
Only tokens younger than `maxTokenAgeHours` when known.
Solana address regex `^[1-9A-HJ-NP-Za-km-z]{32,44}$`; EVM `^0x[a-fA-F0-9]{40}$`.
Explorers: solscan.io/token/, etherscan.io/token/, basescan.org/token/, bscscan.com/token/.

### db/db.ts (node:sqlite `DatabaseSync`, WAL mode)
```ts
export function openDb(file: string): Db      // ':memory:' allowed (tests)
export class Db {
  upsertToken(s: TokenSnapshot): void
  insertSnapshot(s: TokenSnapshot): void
  history(chain: ChainId, address: string, sinceTs: number): TokenSnapshot[]          // oldest→newest
  latestSnapshots(sinceTs: number, limit?: number, active?: { minLiquidityUsd; minVolumeH1Usd }): TokenSnapshot[] // latest per token (the token row: newest observation merged over the stored one, so a sparse observation never erases market data)
  regimeUniverse(now: number, o: { maxObservationAgeMs; minLiquidityUsd; minTokenAgeMs; maxTokenAgeMs }): TokenSnapshot[] // filters in SQL
  trackedAddresses(chain: ChainId, maxAgeHours: number, limit: number, now?: number, active?: { minLiquidityUsd; minVolumeH1Usd }): string[] // young tokens; those clearing the market minimums first, then most recently seen
  insertDetection(e: DetectionEvent): void
  recentDetections(limit: number): DetectionEvent[]
  detectionsFor(chain: ChainId, address: string, limit: number): DetectionEvent[]
  lastDetectionFor(chain: ChainId, address: string): DetectionEvent | null
  insertArticle(a: NewsArticle): void
  getArticle(id: string): NewsArticle | null
  listArticles(q: { limit: number; before?: number | { ts: number; id: string }; chain?: ChainId; severity?: Severity }): NewsArticle[] // newest first, ties by id; the composite cursor is exact
  lastArticleFor(chain: ChainId, address: string): NewsArticle | null
  articlesSince(ts: number): number
  insertDistribution(d: DistributionItem): void
  updateDistribution(id: string, patch: Partial<Pick<DistributionItem,'status'|'sentAt'|'error'>>): void
  distributionFor(articleId: string): DistributionItem[]
  pendingDistribution(limit: number): DistributionItem[]   // status 'queued'
  saveRadar(r: RadarReport): void
  getRadar(id: string): RadarReport | null
  counts(sinceTs: number): { tokensAnalyzed: number; anomalies: number; breaking: number; articles: number; distributed: number; perChainTokens: Record<string, number> }
  prune(now: number): void      // snapshots > 6h (nothing reads past 2h), tokens > 48h, radar > 7d
  close(): void
}
```
Address keys stored normalized (lowercase for EVM) in a `key` column; original casing kept in JSON.

### engine/*
```ts
// metrics.ts — pure
export function deriveMetrics(s: TokenSnapshot, history: TokenSnapshot[], now: number): DerivedMetrics
export function toCardMetrics(s: TokenSnapshot, m: DerivedMetrics): CardMetrics
// anomaly.ts — pure
export interface DetectOpts { thresholds: Record<Severity, number>; minLiquidityUsd: number; minVolumeH1Usd: number; breakingMinLiquidityUsd: number; breakingMinVolumeH1Usd: number; socialMentions?: number | null; launchRamp?: { onsetPerMin: number; fullPerMin: number } }
export function detectAnomalies(s: TokenSnapshot, m: DerivedMetrics, o: DetectOpts): Detection
// baselines.ts — per-chain launch traction (P2)
export class LaunchBaselines { constructor(gates, load?: (sinceTs) => TokenSnapshot[]); observe(s): void; rampFor(chain, now): LaunchRamp }
// scanner.ts
export class Scanner { constructor(d: { adapters: ChainAdapter[]; db: Db; bus: Bus; pipeline: Pipeline; config: AppConfig }); start(): void; stop(): Promise<void>; chainInfo(): ChainInfo[]; lastScanAt(): number | null }
// pipeline.ts
export class Pipeline { constructor(d: { db: Db; bus: Bus; config: AppConfig; adapters: ChainAdapter[]; distribution: DistributionQueue; regime: () => MarketRegime; mentions?: (s: TokenSnapshot) => Promise<number | null>; baselines?: LaunchBaselines });
  /** called by the scanner for every stored snapshot; synchronous, never touches the network, never throws */
  process(s: TokenSnapshot, now: number): void
  settled(): Promise<void>; stop(): Promise<void> }   // background decisions (mentions, enrich, AI write)
// stats.ts
export function buildStats(d: { db: Db; scanner: Scanner; engine: EngineState; distribution: DistributionQueue; startedAt: number; now: number }): Stats
```
Scanner loop: per chain, `discover()` every `discoverIntervalMs` (staggered across chains),
`refresh(trackedAddresses)` every `refreshIntervalMs` (240 tokens per chain, active ones first). Every snapshot → `db.insertSnapshot` + `pipeline.process`.
A scan cycle never waits for an article: `process` decides at once from market data and cached mention counts;
anything that needs the network (a mention lookup that could change the outcome, enrichment, quant, the AI write)
goes to a bounded background pool (4 workers, one pending entry per token, newest snapshot wins, ALERT/BREAKING first).

Rate-limit health: a 429 pauses the provider's whole limiter (retry-after, never less than 15 s, at most 60 s)
instead of letting queued requests hit the provider. DexScreener liquidity that the pool's quote reserve
cannot back (more than 10x twice the quote reserve: fake-priced or single-sided pools) is replaced by the
quote-backed value, and Radar ranks symbol matches by 24 h volume before liquidity.
Chain status: `scanning` if last success < 2 min, `degraded` if last attempt failed but a success < 10 min, `down` otherwise, `idle` before first run.

Detection policy (anomaly.ts, pure):
- Market gates: liquidity ≥ `MIN_LIQUIDITY_USD`, 1 h volume ≥ `MIN_VOLUME_H1_USD`, not a honeypot, < 7 days old, and
  liquidity not pulled (≤ −50 % against our own history of the same pool → rejected "Liquidity pulled").
- BREAKING needs real size (liquidity ≥ `BREAKING_MIN_LIQUIDITY_USD` $25K and 1 h volume ≥ `BREAKING_MIN_VOLUME_H1_USD` $75K) and
  no structural rug risk (top-10 holders < 80 %, mint and freeze authority not enabled); otherwise it is held at ALERT
  and `Detection.caps` says why. Unknown holder concentration also caps (BREAKING is a trust claim; the story still
  publishes immediately as ALERT); other unknown values never cap.
- 5m-vs-1h ratios use the age of the pool the windows were measured on (`pairCreatedAt`); unknown → null, never "a full hour".
  Liquidity growth is measured only within one pool, one provider and one valuation method.
- Launch traction (`fresh_launch`) is scaled per chain: onset at the chain's p50 volume-per-minute of young (≤ 90 min)
  launches clearing the gates over the last 6 h, full weight at ~1.25 × p90 (sample ≥ 30, recomputed ≤ every 5 min,
  bounded to 0.25-2.5 × the global $10K/$50K ramp; too few launches → the global ramp).

Pipeline decision per snapshot:
1. `deriveMetrics` with 90-min history → `detectAnomalies`.
2. severity null → stop. WATCH → store `DetectionEvent` (dedupe: max one per token per 10 min unless score +10) and emit `detection`. No article.
3. ALERT/BREAKING (background) → `adapter.enrich()` (holders/security, main-pool wallet counts and main-pool creation time; cache 3 min per token; never waits out a GT 429 pause;
   the pool's creation time fills an unknown token age, earliest wins, so a weeks-old token cannot pass as a launch) → recompute metrics/detection
   → `matchQuant` → `writeArticle` → `db.insertArticle` → `distribution.enqueue` → `bus.emit('article')`.
   Cooldown: one article per token per `articleCooldownMin` unless severity escalates (ALERT→BREAKING) or score +15;
   a follow-up sets `updateOf`. Global cap `maxArticlesPerHour`. Honeypot = 'yes' → never publish.
4. Every stage stamps `PipelineTimings`.

### quant/*
```ts
export const METHODOLOGIES: QuantMethodology[]   // 10–12, own words, each with paper link + Quantpedia link where one exists (verified URLs)
export const SOURCE_POLICY: string
export function matchQuant(s: TokenSnapshot, m: DerivedMetrics, regime: MarketRegime, o?: { socialMentions?: number | null }): QuantResult
export function computeRegime(latest: TokenSnapshot[], now: number): MarketRegime
export function createRegimeProvider(load, o): () => MarketRegime   // the ONE regime shared by articles, Radar and /api/quant/leaders
export function computeLeaders(entries: Array<{ snapshot: TokenSnapshot; metrics: DerivedMetrics; articleId: string | null }>, regime: MarketRegime, topN?: number): QuantLeader[]
```
Score = Σ(weight·fit)/Σ(weight over features with data) × 100, then × min(1, coverage/0.6).
Unknown security facts (e.g. honeypot 'unknown') are missing data, never a red flag. Every paper a methodology names is linked.
Families to cover: time-series momentum, short-term reversal (mean reversion), trend following, volume/price breakout (high-volume return premium), volatility-managed exposure (risk), Amihud illiquidity, order-flow imbalance, investor attention, market regime filter, crypto size/momentum factors, risk-management overlay.

### ai/*
```ts
// claude.ts
export function initClaude(config: AppConfig): void
export function claudeClient(): Anthropic | null           // null when no key
export function engineState(): EngineState                   // ai:'claude'|'rules', model, aiError (last failure)
export function reportAiError(e: unknown): void; export function reportAiOk(): void
// newswriter.ts
export interface NewsInput { snapshot: TokenSnapshot; metrics: DerivedMetrics; detection: Detection; quant: QuantResult; lang: 'es'|'en'; previous: NewsArticle | null }
export type ArticleDraft = Pick<NewsArticle,'headline'|'lede'|'aiLine'|'whyItMatters'|'quantAnalysis'|'outlook'|'engine'|'model'|'lang'>
export async function writeArticle(i: NewsInput): Promise<ArticleDraft>   // Claude (structured output, timeout) → fallback rules. Never throws.
// rules-writer.ts
export function writeArticleRules(i: NewsInput): ArticleDraft
// brief.ts
export async function writeRadarBrief(i: { snapshot: TokenSnapshot; metrics: DerivedMetrics; detection: Detection; quant: QuantResult; intel: IntelItem[]; lang: 'es'|'en' }, o?: { claude?: boolean; signal?: AbortSignal }): Promise<RadarBrief>
// web-research.ts
export async function researchWeb(t: { chain: ChainId; address: string; symbol: string; name: string }, o?: { signal?: AbortSignal }): Promise<IntelItem[]> // [] only without key; throws WebResearchError on failure; cached 15 min per token
// format.ts — number formatting shared by writers/distribution
export function fmtUsd(n: number | null): string   // $1.4M, $620K, $0.000012
export function fmtPct(n: number | null, digits?: number): string
export function fmtAge(minutes: number | null, lang: 'es'|'en'): string
```
Claude usage (from the claude-api skill — follow exactly):
- Model from config (default `claude-opus-5-5`). Opus 5.5: **never** send `thinking: {type:'disabled'}`, `budget_tokens`, `temperature`, or forced `tool_choice`. Set `output_config.effort` explicitly (news: `low`, research: `medium`).
- Structured JSON: `output_config: { format: { type: 'json_schema', schema } }` on `client.messages.create`, then `JSON.parse` the text block and validate with zod. Check `stop_reason` (`refusal`, `max_tokens`) before parsing.
- Static system prompt as `system: [{ type:'text', text, cache_control:{type:'ephemeral'} }]` (no timestamps in it).
- Web research: `tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]`. Collect sources from `web_search_tool_result` blocks (`content` is an array of `{url,title,page_age}` on success, an error object otherwise). Handle `pause_turn` by re-sending (max 2 continuations). Do not combine web search with `output_config.format`; ask for a short JSON-ish summary in text or rely on the result blocks.
- Per-request timeout `{ timeout: config.ai.timeoutMs }` (plus the caller's `signal` where it can give up), `maxRetries: 1`. Catch typed errors (`Anthropic.AuthenticationError`, `RateLimitError`, `APIError`) → `reportAiError`, fall back to rules.
  `aiError` (public) is a fixed category; provider error text goes to the server log only.
- Output guard: no hype vocabulary (EN/ES), no predictions ("will rise", "subirá", "garantizado"), no multiple ("100x")
  or figure that the facts do not state ("/100" scores do not license "100"). `facts.token.windowsSinceLaunch` lists
  windows longer than the token's trading life; those figures are written "since launch".

### distribution/*
```ts
export function formatForChannels(a: NewsArticle, publicBaseUrl: string | null): Array<{ channel: DistributionChannel; payload: string }>
// x: ≤ 280 chars (count URLs as 23), telegram: HTML parse mode (escape &<>), discord: JSON embed {embeds:[…]}, webhook: JSON of a compact article
export class DistributionQueue {
  constructor(d: { db: Db; config: AppConfig })
  enqueue(a: NewsArticle): DistributionItem[]   // creates one item per channel; 'queued' if that channel is configured AND severity ≥ minSeverity, else 'ready' (copy-paste) ; x is always 'ready' (never auto-posted)
  start(): void; stop(): Promise<void>        // worker sends queued items (Discord webhook, Telegram sendMessage, generic webhook POST) with retry/backoff, max 3 attempts → 'failed'; stop() waits for the send in flight
  enabledChannels(): DistributionChannel[]; sentSince(ts: number): number
}
```

Every post carries the risk scenario (`outlook.risk`) and a not-financial-advice notice; the quant figure reads
"<methodology> 72/100 (not a forecast)". Creator-chosen symbols and names are defused (no auto-link, mention or command)
and an article whose symbol or name looks like a link is held for review instead of auto-posted. `DistributionItem.error`
is a fixed category ("HTTP 404", "timeout", "rejected by Telegram"); the target's own answer is logged, redacted.

### research/*
```ts
// freshness.ts
export function classifyFreshness(publishedAt: number | null, now: number, precision?: 'exact' | 'day'): Freshness // a calendar date is never LIVE
export function parsePublishedDate(raw: string | null | undefined, now: number): number | null // ISO, RFC 2822, GDELT "20261001T143000Z", "3 hours ago", "Oct 1, 2026"
// intel/*.ts — each: search(t: IntelQuery): Promise<IntelItem[]> ; IntelQuery = { symbol: string; name: string; address: string; chain: ChainId; links: TokenLink[] }
// intel/index.ts
export async function gatherIntel(t: IntelQuery, now: number, o?: { signal?: AbortSignal; webResearch?: { run: true } | { run: false; reason: string | null } }): Promise<{ items: IntelItem[]; providers: IntelProviderStatus[] }>
export async function quickMentions(s: TokenSnapshot): Promise<number | null> // cheap (hn + biz, cached 5 min) count of contract or distinctive-name mentions in last 2 h, for the detection pipeline
// radar.ts
export class RadarService {
  constructor(d: { adapters: ChainAdapter[]; db: Db; config: AppConfig; regime: () => MarketRegime; baselines?: LaunchBaselines })
  start(query: string, chain?: ChainId, o?: { client?: string }): RadarReport // returns immediately with status 'running'; throws RadarBusyError beyond 4 running
  get(id: string): RadarReport | null
  subscribe(id: string, fn: (r: RadarReport) => void): () => void
}
```
Radar flow: `resolve` (strip `$`, trim; address → one DexScreener search says which chains list it, then `lookup` there, in parallel;
otherwise `dsSearch` filtered to supported chains, exact symbol match preferred, ranked by liquidity; others → `candidates`)
→ `onchain` (lookup snapshot + history → metrics, detection) → `holders` (`enrich`) → `quant` → `web` (`gatherIntel`, matching
on symbol only when the symbol has ≥3 chars, always on contract address and on exact name) → `ai` (`writeRadarBrief`).
Fields we cannot provide go in `unavailable` with a reason (e.g. smart money → "requires a labelled-wallet provider").
`RadarReport.providers` holds each intel provider's outcome (a failure or a skip is `ok: false` with its reason, never "0 found").
Every stage has a deadline that cancels its work; provider calls use the Radar lane and fail fast; paid Claude calls
(web research, brief) draw from `RADAR_AI_CALLS_PER_HOUR` and a per-visitor quota (4 per 10 min), and are reused per
token (web research 15 min, Claude brief 10 min with `writtenAt`). A repeated query joins a running or finished report
within 20 s; a failed or not-found one runs again; base58 addresses keep their case in the dedupe key.
Intel matching must avoid false positives: short/generic symbols ("AI", "CAT") need name, chain or address co-occurrence
(a cashtag or "CAT coin" alone does not count); Claude web-search hits need the same textual evidence as any provider.

### http/*
REST (JSON) under `/api`:
```
GET  /api/health                         { ok, uptimeSec }
GET  /api/stats                          Stats
GET  /api/feed?limit=40&before=&chain=&severity=   FeedResponse (before = nextCursor "<createdAt>:<id>", or a legacy createdAt)
GET  /api/articles/:id                   ArticleResponse | 404
GET  /api/detections?limit=50            { events: DetectionEvent[] }
GET  /api/stream                         SSE StreamEvent (hello → article/detection live, stats every 5 s, comment heartbeat every 15 s)
POST /api/radar        { query, chain? } { id } (400 on empty / >120 chars)
GET  /api/radar/:id                      RadarReport | 404
GET  /api/radar/:id/stream               SSE RadarStreamEvent
GET  /api/quant/library                  QuantLibraryResponse
GET  /api/quant/leaders                  QuantLeadersResponse (cached 15 s)
```
Static: serves `web/dist` with SPA fallback when it exists (files are looked up per request, so a web rebuild
while the server runs is served at once). SSE: `content-type: text/event-stream`,
`cache-control: no-cache, no-transform`, `x-accel-buffering: no`; clean up listeners on close.
Basic hardening: radar POST rate limit 10/min per client (IPv6 bucketed by /64, IPv4-mapped normalized) and 60/min
overall, 503 while 4 investigations run; event streams capped at 6 per client and 1,000 in total (429/503), at most
20 viewers per running radar report; the hello frame is cached 1 s; a non-reading stream is cut at 256 KiB pending
(1 MiB buffered); request timeout 15 s; body limit 4 KB; CORS off by default. `TRUST_PROXY` accepts proxy IPs/CIDRs or a
hop count, never "trust every hop" (a spoofed X-Forwarded-For must not choose `request.ip`).

## Frontend (web/)
React 19 + Vite + TypeScript. Libraries (from the curated `pick-ui-library` list — do not substitute):
`@number-flow/react` (live counters), `sonner` (breaking toasts), `zustand` (state), `clsx`, `react-virtuoso` (feed),
fonts `@fontsource-variable/inter` + `@fontsource-variable/jetbrains-mono`.
Three tabs only — LIVE · RADAR · INTELLIGENCE — hash-routed (`#/live`, `#/radar?q=`, `#/intelligence`).
Design brief in `docs/DESIGN.md`.

## Environment
See `.env.example`. Without `ANTHROPIC_API_KEY` the platform runs fully on the rules writer and says so in the header.
Invalid configuration (unknown chain, unreadable boolean, unordered thresholds, negative or fractional counts) stops
startup with a message naming the variable.
