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
export interface FetchOpts { timeoutMs?: number /*8000*/; retries?: number /*1, only for 429/5xx/network*/; headers?: Record<string,string>; limiter?: string /* key of a registered limiter */; cacheTtlMs?: number }
export function registerLimiter(key: string, opts: { perMinute: number; minIntervalMs?: number }): void
export async function fetchJson<T = unknown>(url: string, opts?: FetchOpts): Promise<T>
export async function fetchText(url: string, opts?: FetchOpts): Promise<string>
```
Default User-Agent `HootRadar/0.1 (+crypto intelligence newsroom)`. 429 honours `retry-after`.
Limiter = async token bucket queue (requests wait, never dropped). Cache keyed by URL.
Pre-registered limiters: `geckoterminal` 25/min, `dexscreener` 250/min, `dexscreener-meta` 55/min,
`pumpfun` 30/min, `gdelt` 10/min minInterval 5500ms, `hn` 60/min, `biz` 30/min minInterval 1000ms.

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
export function mergeSnapshots(base: TokenSnapshot, extra: Partial<TokenSnapshot>): TokenSnapshot // non-null wins over null; union sources/links; keep earliest createdAt
export function emptySnapshot(chain: ChainId, address: string, ts: number): TokenSnapshot
```
All parse functions are pure and exported separately (`parseGtPools(json, chain)`, `parseDsPairs(json, chain)`, …) so tests run against fixtures without network.

### chains/*
```ts
export const CHAIN_CONFIGS: Record<KnownChainId, ChainConfig>
export function createAdapter(config: ChainConfig): ChainAdapter   // generic Gecko+DexScreener adapter
export function createChainAdapters(ids: KnownChainId[]): ChainAdapter[] // solana adapter adds pump.fun to discover()
```
`discover()` = GT new_pools (+ pump.fun newest for Solana, + DexScreener latest listings for this chain),
then a DexScreener batch refresh of the discovered addresses to fill txns/volume where GT lacked them.
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
  latestSnapshots(sinceTs: number, limit?: number): TokenSnapshot[]                     // latest per token
  trackedAddresses(chain: ChainId, maxAgeHours: number, limit: number, now?: number, active?: { minLiquidityUsd; minVolumeH1Usd }): string[] // young tokens; those clearing the market minimums first, then most recently seen
  insertDetection(e: DetectionEvent): void
  recentDetections(limit: number): DetectionEvent[]
  detectionsFor(chain: ChainId, address: string, limit: number): DetectionEvent[]
  lastDetectionFor(chain: ChainId, address: string): DetectionEvent | null
  insertArticle(a: NewsArticle): void
  getArticle(id: string): NewsArticle | null
  listArticles(q: { limit: number; before?: number; chain?: ChainId; severity?: Severity }): NewsArticle[] // newest first
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
export interface DetectOpts { thresholds: Record<Severity, number>; minLiquidityUsd: number; minVolumeH1Usd: number; socialMentions?: number | null }
export function detectAnomalies(s: TokenSnapshot, m: DerivedMetrics, o: DetectOpts): Detection
// scanner.ts
export class Scanner { constructor(d: { adapters: ChainAdapter[]; db: Db; bus: Bus; pipeline: Pipeline; config: AppConfig }); start(): void; stop(): Promise<void>; chainInfo(): ChainInfo[]; lastScanAt(): number | null }
// pipeline.ts
export class Pipeline { constructor(d: { db: Db; bus: Bus; config: AppConfig; adapters: ChainAdapter[]; distribution: DistributionQueue; regime: () => MarketRegime; mentions?: (s: TokenSnapshot) => Promise<number | null> });
  /** called by the scanner for every refreshed snapshot; decides, enriches, writes, publishes. Never throws. */
  process(s: TokenSnapshot, now: number): Promise<void> }
// stats.ts
export function buildStats(d: { db: Db; scanner: Scanner; engine: EngineState; distribution: DistributionQueue; startedAt: number; now: number }): Stats
```
Scanner loop: per chain, `discover()` every `discoverIntervalMs` (staggered across chains),
`refresh(trackedAddresses)` every `refreshIntervalMs` (240 tokens per chain, active ones first). Every snapshot → `db.insertSnapshot` + `pipeline.process`.

Rate-limit health: a 429 pauses the provider's whole limiter (retry-after, never less than 15 s, at most 60 s)
instead of letting queued requests hit the provider. DexScreener liquidity that the pool's quote reserve
cannot back (more than 10x twice the quote reserve: fake-priced or single-sided pools) is replaced by the
quote-backed value, and Radar ranks symbol matches by 24 h volume before liquidity.
Chain status: `scanning` if last success < 2 min, `degraded` if last attempt failed but a success < 10 min, `down` otherwise, `idle` before first run.

Pipeline decision per snapshot:
1. `deriveMetrics` with 90-min history → `detectAnomalies`.
2. severity null → stop. WATCH → store `DetectionEvent` (dedupe: max one per token per 10 min unless score +10) and emit `detection`. No article.
3. ALERT/BREAKING → `adapter.enrich()` (holders/security, main-pool wallet counts and main-pool creation time; cache 3 min per token;
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
export function computeLeaders(entries: Array<{ snapshot: TokenSnapshot; metrics: DerivedMetrics; articleId: string | null }>, regime: MarketRegime, topN?: number): QuantLeader[]
```
Score = Σ(weight·fit)/Σ(weight over features with data) × 100, then × min(1, coverage/0.6).
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
export async function writeRadarBrief(i: { snapshot: TokenSnapshot; metrics: DerivedMetrics; detection: Detection; quant: QuantResult; intel: IntelItem[]; lang: 'es'|'en' }): Promise<RadarBrief>
// web-research.ts
export async function researchWeb(t: { chain: ChainId; address: string; symbol: string; name: string }): Promise<IntelItem[]> // [] without key
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
- Per-request timeout `{ timeout: config.ai.timeoutMs }`, `maxRetries: 1`. Catch typed errors (`Anthropic.AuthenticationError`, `RateLimitError`, `APIError`) → `reportAiError`, fall back to rules.

### distribution/*
```ts
export function formatForChannels(a: NewsArticle, publicBaseUrl: string | null): Array<{ channel: DistributionChannel; payload: string }>
// x: ≤ 280 chars (count URLs as 23), telegram: HTML parse mode (escape &<>), discord: JSON embed {embeds:[…]}, webhook: JSON of a compact article
export class DistributionQueue {
  constructor(d: { db: Db; config: AppConfig })
  enqueue(a: NewsArticle): DistributionItem[]   // creates one item per channel; 'queued' if that channel is configured AND severity ≥ minSeverity, else 'ready' (copy-paste) ; x is always 'ready' (never auto-posted)
  start(): void; stop(): void                  // worker sends queued items (Discord webhook, Telegram sendMessage, generic webhook POST) with retry/backoff, max 3 attempts → 'failed'
  enabledChannels(): DistributionChannel[]; sentSince(ts: number): number
}
```

### research/*
```ts
// freshness.ts
export function classifyFreshness(publishedAt: number | null, now: number): Freshness
export function parsePublishedDate(raw: string | null | undefined, now: number): number | null // ISO, RFC 2822, GDELT "20261001T143000Z", "3 hours ago", "Oct 1, 2026"
// intel/*.ts — each: search(t: IntelQuery): Promise<IntelItem[]> ; IntelQuery = { symbol: string; name: string; address: string; chain: ChainId; links: TokenLink[] }
// intel/index.ts
export async function gatherIntel(t: IntelQuery, now: number): Promise<{ items: IntelItem[]; providers: Array<{ provider: string; ok: boolean; count: number; error: string | null }> }>
export async function quickMentions(s: TokenSnapshot): Promise<number | null> // cheap (hn + biz, cached 5 min) count of mentions in last 2 h, for the detection pipeline
// radar.ts
export class RadarService {
  constructor(d: { adapters: ChainAdapter[]; db: Db; config: AppConfig; regime: () => MarketRegime })
  start(query: string, chain?: ChainId): RadarReport             // returns immediately with status 'running'; work continues async
  get(id: string): RadarReport | null
  subscribe(id: string, fn: (r: RadarReport) => void): () => void
}
```
Radar flow: `resolve` (strip `$`, trim; address → `lookup` on every chain whose pattern matches, in parallel;
otherwise `dsSearch` filtered to supported chains, exact symbol match preferred, ranked by liquidity; others → `candidates`)
→ `onchain` (lookup snapshot + history → metrics, detection) → `holders` (`enrich`) → `quant` → `web` (`gatherIntel`, matching
on symbol only when the symbol has ≥3 chars, always on contract address and on exact name) → `ai` (`writeRadarBrief`).
Fields we cannot provide go in `unavailable` with a reason (e.g. smart money → "requires a labelled-wallet provider").
Intel matching must avoid false positives: short/generic symbols ("AI", "CAT") need name or address co-occurrence.

### http/*
REST (JSON) under `/api`:
```
GET  /api/health                         { ok, uptimeSec }
GET  /api/stats                          Stats
GET  /api/feed?limit=40&before=&chain=&severity=   FeedResponse
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
Basic hardening: radar POST rate limit 10/min per IP, body limit 4 KB, CORS off by default.

## Frontend (web/)
React 19 + Vite + TypeScript. Libraries (from the curated `pick-ui-library` list — do not substitute):
`@number-flow/react` (live counters), `sonner` (breaking toasts), `zustand` (state), `clsx`, `react-virtuoso` (feed),
fonts `@fontsource-variable/inter` + `@fontsource-variable/jetbrains-mono`.
Three tabs only — LIVE · RADAR · INTELLIGENCE — hash-routed (`#/live`, `#/radar?q=`, `#/intelligence`).
Design brief in `docs/DESIGN.md`.

## Environment
See `.env.example`. Without `ANTHROPIC_API_KEY` the platform runs fully on the rules writer and says so in the header.
