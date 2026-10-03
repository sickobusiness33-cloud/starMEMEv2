# HootRadar — Design brief

A crypto intelligence terminal that is visibly *working in real time*. Bloomberg density,
newsroom clarity, far simpler. No landing page, no hero, no decorative charts. Every pixel
either carries information or gets out of the way.

Design-engineering rules come from the bundled skills (Emil Kowalski): `emil-design-eng`,
`animate` (+ RECIPES.md), `mobile-native`, `pick-ui-library`, `ask-sonner`, `review-animations`.
Skill files: `$SKILLS/<name>/SKILL.md` (path given in the task prompt). Read them before writing UI code.

## Tokens (`web/src/styles/tokens.css`)

```css
:root {
  color-scheme: dark;
  --bg: #050607;        /* page */
  --bg-1: #0a0c0e;      /* bars, rails */
  --bg-2: #0e1114;      /* cards */
  --bg-3: #141a1e;      /* raised / hover / expanded */
  --line: #1a2026;      /* hairlines */
  --line-2: #26303a;    /* stronger borders, focus base */
  --text: #e8ecef;
  --text-2: #a1abb4;
  --text-3: #7a858f;    /* AA (4.5:1+) on every surface; #66717b failed it */
  --green: #3dff8f;     /* neon — live, BREAKING, positive, primary action */
  --green-dim: rgb(61 255 143 / 0.12);
  --on-green: #03140a;  /* text on a green fill (BREAKING tag) */
  --green-hover: #6bffaa; /* primary button hover */
  --cyan: #2fe0ff;      /* AI, ALERT, links, focus */
  --cyan-dim: rgb(47 224 255 / 0.12);
  --on-cyan: #001218;   /* text on a cyan fill (skip link) */
  --red: #ff5a6a;       /* risk only (risk outlook, risk flags, sells) */
  --red-dim: rgb(255 90 106 / 0.12);
  --amber: #ffc04d;     /* degraded / held-back states only (chain degraded, AI fallback, severity cap) */
  --amber-dim: rgb(255 192 77 / 0.12);
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --dur-press: 120ms;   /* press feedback */
  --dur-hover: 150ms;   /* hover color */
  --dur-ui: 200ms;      /* indicator slides, small popovers */
  --dur-enter: 220ms;   /* list entries, accordion */
  --font-sans: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono Variable', ui-monospace, 'SFMono-Regular', Menlo, monospace;
  --radius: 10px;
  --radius-sm: 6px;
}
```
Lines, bars, glows, glass and shadows are derived in `tokens.css` (`--green-line`, `--cyan-line`,
`--amber-line`, `--bar-glass`, `--shadow-*` …) with `color-mix()` from the tokens above, so changing a
token carries through; components never use literal colors.
Chain dots (small, 6px): solana `#b18cff`, ethereum `#8ea2ff`, base `#3d7bff`, bsc `#f3c344` — take from `ChainInfo.color`.

Typography: Inter for prose (14px base, 1.5 line height); JetBrains Mono for numbers, tickers,
labels, timestamps. Labels: mono 10.5–11px uppercase, `letter-spacing: .08em`, `--text-3`.
All numerals `font-variant-numeric: tabular-nums`. Background: `--bg` with an extremely faint
1px grid (≤ 3% opacity) — the only decoration allowed.

## Shell

**Top bar** (sticky, `--bg-1`, hairline bottom, padded with `env(safe-area-inset-top)`):
- Left: small radar/owl SVG mark + `HOOTRADAR` (mono, 600, letter-spaced).
- Engine pill: `● AI ENGINE ACTIVE` — green dot with a soft expanding ring (CSS keyframes, linear,
  2.4 s, constant motion = linear is correct; static under reduced motion). Sub-label shows the real
  engine: `CLAUDE · claude-opus-5-5`, or for the rules engine the pill reads `● ENGINE ACTIVE` with
  sub-label `RULES ENGINE` (never claim AI when it isn't). A Claude engine reporting `aiError` shows an
  amber `AI ERROR · FALLBACK RULES` sub-label. `starting` → cyan "BOOTING", `degraded` → amber
  "DEGRADED". At ≤ 1199px the pill shows the short label (`AI ACTIVE` / `RULES ACTIVE` / `AI ERROR`);
  the full label stays readable to screen readers.
- Stat cells divided by hairlines: `{n} CHAINS SCANNING`, `{n} TOKENS ANALYZED`, `{n} ANOMALIES DETECTED`,
  `{n} BREAKING EVENTS` — value mono 15px `--text`, label 10.5px `--text-3`. Values animate with
  `@number-flow/react` (that is what it is for). "24H" scope hint in the label tooltip/title.
- Right: UTC clock `HH:MM:SS UTC` (mono, `--text-2`).

**Tab bar** (desktop: under the top bar; mobile < 720px: fixed bottom bar with safe-area padding):
`LIVE` `RADAR` `INTELLIGENCE` — mono uppercase. Active = `--text` + 2px neon underline that slides
(transform, 200ms `--ease-out`); keyboard shortcuts `1/2/3` switch instantly (no animation for keyboard
actions). Right side of the tab bar: chain status chips `● SOL 12s` (dot color = status: scanning green,
degraded amber, down red, idle gray; seconds since last scan, real).

## LIVE

Desktop ≥ 1100px: feed column (max ~760px) + right rail (320px). Tablet: feed only, rail below.
Feed toolbar: chain filter chips (All · SOL · ETH · BASE · BNB) + severity toggle (All · Breaking+Alert · Breaking).

**News card** (`--bg-2`, 1px `--line`, radius 10, padding 14–16):
```
[BREAKING] $TOKEN  Token Name                          ● Solana · 18 min ago
MC $1.4M   VOL 1H $620K   TX/MIN 184   BUY/SELL 71/29   HOLDERS +31%
▮▮▮▮▮▮▮▮▱▱ QUANT MATCH 84% · Time-series momentum
AI  El token está mostrando una aceleración anormal de actividad on-chain…
```
- Severity tag: BREAKING = filled `--green` with `#03140a` text + 2px green left edge on the card;
  ALERT = cyan outline tag; (WATCH events never become cards — they live in the tape).
- Metric row: label mono 10.5px `--text-3`, value mono 13px `--text`; buy/sell shows a 2px split bar
  (green / red at 70% opacity). Null → `—`.
- Quant: 10-segment meter in cyan + `QUANT MATCH 84%` + methodology name; `title` = disclaimer.
- AI line: `AI` badge (cyan, mono) + `aiLine` in `--text-2`. If `engine === 'rules'` badge reads `RULES`.
- Severity caps: when the article carries `caps` (a score that reached a higher band but was held,
  e.g. BREAKING on a thin market published as ALERT), an amber chip `Capped at ALERT: <reason>` sits
  above the AI line (one line, ellipsized; full reasons in the expanded article's Signals section).
- Relative time updates every 15 s (one shared ticker, not one interval per card).
- Click / Enter expands inline (grid-template-rows 0fr→1fr, 220ms `--ease-out` — the sanctioned
  accordion exception) to the full article:
  headline, lede, **WHY IT MATTERS** (3 bullets), **QUANT ANALYSIS** (text + top 3 matches with bars),
  **AI OUTLOOK** three columns: Bullish (green) / Neutral (text-2) / Risk (red), risk flags,
  signals list, pipeline timing strip `DETECT → ANALYZE → QUANT → WRITE → PUBLISH` with ms deltas,
  links (DexScreener, explorer, website, X, Telegram), copy contract button,
  **DISTRIBUTION** section (fetched from `/api/articles/:id`): per channel payload preview + Copy button + status.
- New card arrival: enter with opacity 0 → 1 and `translateY(-6px)` → 0, 220ms `--ease-out`
  via `@starting-style` (purpose: prevent a jarring insert). BREAKING additionally flashes a
  green inset glow that fades over 1.2 s (state indication). If the user is scrolled down, do not
  shift the list: buffer and show a floating `↑ 3 new` pill.
- BREAKING also fires a Sonner toast (`theme="dark"`, bottom-right desktop, mobileOffset 16,
  styled via `toastOptions.classNames` or `toast.custom`) with a "View" action — only when the user is
  not already looking at the top of the LIVE feed. One `<Toaster />` at the root.

**Right rail**:
1. `SIGNAL TAPE` — newest detection events (all severities) as dense rows:
   `14:32:05  ● $TOKEN  WATCH 52  Volume 4.1x`. Max 60 rows, newest on top.
2. `PIPELINE` — last article's real stage timings (DETECT→ANALYZE→QUANT→WRITE→PUBLISH, ms).
3. `CHAINS` — per chain: status, last scan, tokens seen 24h, last error (truncated, title = full).

Empty state (honest): "Scanning {n} chains. Anomalies appear here the moment the engine detects
them." + the live chain list. Never fake cards. Skeletons only while the first fetch is in flight.

## RADAR

Search row (not a hero): input `Search token / contract address` (mono, ≥ 16px font so iOS does not
zoom, `enterkeyhint="search"`, `autocapitalize="none"`, `autocorrect="off"`, `spellcheck=false`),
chain select (Auto · SOL · ETH · BASE · BNB), `SEARCH` button (green, press scale .97).
Recent searches (localStorage, try/catch) as chips.

Investigation view:
- Stage stepper: RESOLVE · ON-CHAIN · HOLDERS · QUANT · WEB · AI — each with status dot
  (pending gray, running cyan pulse, done green, skipped gray strike, error red) + message.
- Token header: image (lazy, 28px, rounded), `$SYMBOL Name`, chain, short address with copy button,
  links, age.
- Metrics grid (auto-fill, min 150px): Blockchain, Price, Market cap, Liquidity, Volume (5m/1h/24h),
  Transactions (1h/24h), Tx/min, Holders, Holder growth, Buy/Sell ratio, Wallet activity
  (unique buyers/sellers 5m/1h), Smart money (proxy + note), Momentum, Volatility, Token age.
  Each cell: label, value, small sub-line. Unknown → `—` + reason from `report.unavailable`.
- Detection: the severity word large with `score N` beside it, a WATCH | ALERT | BREAKING band meter
  (default thresholds 22 / 42 / 60, filled up to the severity, tick at the score), amber
  `Capped at <severity>: <reason>` chips when `detection.caps` holds the band, then signals chips.
  Quant panel: top matches with bars + regime + risk flags + disclaimer.
- Internet intel: segmented control `ALL · LIVE · RECENT · OLD` with counts; rows: freshness badge
  (LIVE green w/ dot, RECENT cyan, OLD gray, UNKNOWN dim), source type tag, source name, time ago,
  title (link, `rel="noopener noreferrer"`, `target=_blank`), snippet. An item dated by day only
  (`publishedPrecision: 'day'`) shows the date (`2026-10-01`), never a minute-precise time ago, and is
  never LIVE. Provider status line underneath from `report.providers` (which sources answered, with
  counts, or failed / were not run and why — honesty).
- AI brief: summary, bullets, outlook trio. Engine badge. A brief reused from a recent search of the
  same token (`writtenAt` before the report started) says `Written N min ago · reused …`.
- Ambiguous symbol: "Also matching" candidate chips → clicking re-runs on that address+chain.
- Deep link `#/radar?q=…&chain=…` auto-runs.

## INTELLIGENCE

- Regime banner: `MARKET REGIME · RISK-ON` + breadth %, median 1h change, sample size, computed time.
  The note states the real sample: young tokens observed in the last 60 min, at least 45 min old, with
  $5K+ liquidity (fewer than 12 → `Unknown`).
- Methodology library (responsive grid, 1–3 columns): name, family tag, summary, "Looks for" (signature),
  "Crypto adaptation", horizon, caveats, references (paper / Quantpedia link icons).
  Each card has a `LIVE LEADERS` strip: top tokens matching it now (from `/api/quant/leaders`) with
  score bars; click → Radar for that token.
- Footer: disclaimer + source policy text (from the API).

## Motion & interaction rules (from the skills — enforced in review)

- Only `transform`/`opacity` (and `clip-path`; `grid-template-rows` for the accordion). Never `transition: all`.
- Enter/exit: `--ease-out`; on-screen movement: `--ease-in-out`; hover color: `ease`; constant: `linear`.
- UI durations 120–250ms; press feedback `scale(.97)` 120ms on every button-like control.
- No `scale(0)` entrances (start ≥ .95 + opacity 0). Stagger only on first render of a list (≤ 40ms/item, max 6 items).
- All `:hover` rules inside `@media (hover: hover) and (pointer: fine)`.
- `@media (prefers-reduced-motion: reduce)`: drop transforms/pulses, keep short opacity fades.
- Mobile baseline (mobile-native): `viewport-fit=cover`, `interactive-widget=resizes-content`, no zoom
  disabling, `-webkit-tap-highlight-color: transparent`, `overscroll-behavior: none` on html/body and
  `contain` on inner scrollers, `100dvh` app shell, `touch-action: manipulation` + `user-select:none` on
  controls only, inputs ≥ 16px, `theme-color` `#0a0c0e`, `env(safe-area-inset-*)` on fixed bars.
- Focus: `:focus-visible` 2px cyan outline offset 2px. Tabs are a real `role="tablist"`.
- Performance: one SSE connection; zustand store; memoized cards; Virtuoso for the feed once it
  exceeds ~50 cards; images lazy + fixed size; no layout shift on live updates.
