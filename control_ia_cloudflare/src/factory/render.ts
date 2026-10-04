// Constructor de páginas de la fábrica. El LLM propone el producto (texto, marca, widgets) y este
// módulo lo convierte en HTML seguro y accesible:
//   - todo el texto se escapa (cero HTML del modelo → sin XSS por construcción);
//   - colores validados por contraste WCAG; tipografías de una lista cerrada;
//   - JavaScript único y auditado (/fx-runtime.js), sin scripts inline;
//   - widgets funcionales con datos reales (DexScreener/CoinGecko) o cálculos con fórmulas publicadas.

export const ARCHETYPES = ["terminal", "editorial", "bento", "spotlight", "split"] as const;
export const WIDGETS = ["crypto-trending", "crypto-new", "crypto-lookup", "crypto-market", "crypto-watchlist", "ai-tool", "calc-tdee", "calc-macros", "calc-1rm", "calc-pace", "calc-hrzones"] as const;
export type Widget = (typeof WIDGETS)[number];
export const WIDGET_DATA: Partial<Record<Widget, string>> = {
  "crypto-trending": "crypto.trending", "crypto-new": "crypto.new", "crypto-lookup": "crypto.search", "crypto-market": "crypto.market", "crypto-watchlist": "crypto.search",
};

export const FONT_PAIRS: Record<string, { head: string; body: string; q: string }> = {
  geist: { head: "Geist", body: "Geist", q: "family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;600" },
  grotesk: { head: "Space Grotesk", body: "Inter", q: "family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600" },
  sora: { head: "Sora", body: "Inter", q: "family=Sora:wght@500;600;700&family=Inter:wght@400;500;600" },
  syne: { head: "Syne", body: "Manrope", q: "family=Syne:wght@600;700;800&family=Manrope:wght@400;500;600" },
  unbounded: { head: "Unbounded", body: "DM Sans", q: "family=Unbounded:wght@500;600;700&family=DM+Sans:wght@400;500;600" },
  fraunces: { head: "Fraunces", body: "Inter", q: "family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Inter:wght@400;500;600" },
  instrument: { head: "Instrument Serif", body: "Inter", q: "family=Instrument+Serif&family=Inter:wght@400;500;600" },
  bricolage: { head: "Bricolage Grotesque", body: "Inter", q: "family=Bricolage+Grotesque:wght@500;700;800&family=Inter:wght@400;500;600" },
  outfit: { head: "Outfit", body: "Outfit", q: "family=Outfit:wght@400;500;600;700" },
  archivo: { head: "Archivo", body: "Archivo", q: "family=Archivo:wght@400;500;600;800" },
};

export interface Spec {
  name: string; tagline: string; niche: string; archetype: (typeof ARCHETYPES)[number];
  brand: { bg: string; surface: string; text: string; muted: string; accent: string; accent2: string; fonts: string; radius: number; mode: "dark" | "light" };
  hero: { eyebrow: string; title: string; subtitle: string; cta: string };
  features: { title: string; text: string }[];
  steps: { title: string; text: string }[];
  faq: { q: string; a: string }[];
  widgets: { type: Widget; title: string; note?: string }[];
  ai: { label: string; placeholder: string; examples: string[]; system: string } | null;
  seo: { title: string; description: string; keywords: string[] };
  disclaimer: string;
  /** Solo en meme coins: concepto de token (no desplegado on-chain). */
  coin?: Coin | null;
}

export interface Coin {
  ticker: string; description: string; lore: string; traits: string[];
  supply: string; distribution: { label: string; pct: number }[];
  roadmap: { phase: string; text: string }[]; community: string[]; logo: boolean;
}

// ------------------------------------------------------------------ saneado
const clean = (v: unknown, max: number, fallback = ""): string =>
  String(v ?? fallback).replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max) || fallback;
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const HEX = /^#[0-9a-f]{6}$/i;

function lum(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function mix(a: string, b: string, t: number) {
  const p = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map((i) => Math.round(p(a, i) * (1 - t) + p(b, i) * t).toString(16).padStart(2, "0")).join("");
}

const NICHE_PALETTES: Record<string, Spec["brand"][]> = {
  crypto: [
    { bg: "#07070a", surface: "#111118", text: "#f4f4f6", muted: "#9a9aab", accent: "#c6ff3d", accent2: "#7c5cff", fonts: "unbounded", radius: 14, mode: "dark" },
    { bg: "#05080f", surface: "#0d1422", text: "#eaf2ff", muted: "#8ea0bf", accent: "#38bdf8", accent2: "#f472b6", fonts: "grotesk", radius: 10, mode: "dark" },
    { bg: "#0b0710", surface: "#161020", text: "#fbf6ff", muted: "#a796bd", accent: "#ff8a3d", accent2: "#a855f7", fonts: "syne", radius: 18, mode: "dark" },
  ],
  ai: [
    { bg: "#fbfaf7", surface: "#ffffff", text: "#141414", muted: "#5c5c5c", accent: "#4f46e5", accent2: "#0ea5e9", fonts: "geist", radius: 14, mode: "light" },
    { bg: "#0a0a0b", surface: "#141416", text: "#f5f5f5", muted: "#a1a1aa", accent: "#a78bfa", accent2: "#34d399", fonts: "sora", radius: 16, mode: "dark" },
    { bg: "#f4f1ea", surface: "#fffdf8", text: "#1b1a17", muted: "#5d5a52", accent: "#e8590c", accent2: "#1c7c54", fonts: "instrument", radius: 6, mode: "light" },
  ],
  nutrition: [{ bg: "#f7f5ee", surface: "#ffffff", text: "#1d2a1f", muted: "#55625a", accent: "#2f8f4e", accent2: "#f59f0b", fonts: "fraunces", radius: 18, mode: "light" }],
  sport: [{ bg: "#0c0d0f", surface: "#16181c", text: "#f6f7f9", muted: "#9aa1ab", accent: "#ff3b30", accent2: "#ffd60a", fonts: "archivo", radius: 8, mode: "dark" }],
};
export const NICHES = ["crypto", "ai", "nutrition", "sport", "other"];

/** Valida y completa la especificación del LLM: nunca confía en ella. */
export function normalizeSpec(raw: any, niche: string, seed: number): Spec {
  const pals = NICHE_PALETTES[niche] ?? NICHE_PALETTES.ai;
  const base = pals[seed % pals.length];
  const b = raw?.brand ?? {};
  const pick = (k: keyof Spec["brand"]) => (typeof b[k] === "string" && HEX.test(b[k]) ? b[k].toLowerCase() : base[k]) as string;
  const brand: Spec["brand"] = {
    bg: pick("bg"), surface: pick("surface"), text: pick("text"), muted: pick("muted"), accent: pick("accent"), accent2: pick("accent2"),
    fonts: FONT_PAIRS[b.fonts] ? b.fonts : base.fonts, radius: Math.max(0, Math.min(28, Number(b.radius) || base.radius)), mode: b.mode === "light" || b.mode === "dark" ? b.mode : base.mode,
  };
  // Contraste WCAG: texto ≥ 7:1, secundario ≥ 4.5:1, acento ≥ 3:1 sobre el fondo.
  const light = lum(brand.bg) > 0.4;
  brand.mode = light ? "light" : "dark";
  if (contrast(brand.text, brand.bg) < 7) brand.text = light ? "#111111" : "#f5f5f5";
  if (contrast(brand.surface, brand.bg) > 1.6 || contrast(brand.text, brand.surface) < 7) brand.surface = mix(brand.bg, light ? "#ffffff" : "#ffffff", light ? 0.6 : 0.05);
  for (let i = 0; i < 8 && contrast(brand.muted, brand.bg) < 4.6; i++) brand.muted = mix(brand.muted, brand.text, 0.25);
  for (let i = 0; i < 8 && contrast(brand.accent, brand.bg) < 3; i++) brand.accent = mix(brand.accent, light ? "#000000" : "#ffffff", 0.2);

  const list = <T,>(v: unknown, n: number, f: (x: any) => T | null): T[] => (Array.isArray(v) ? v : []).map(f).filter((x): x is T => !!x).slice(0, n);
  const name = clean(raw?.name, 40, "Kairo Labs");
  const allowed = new Set(WIDGETS.filter((w) => (niche === "crypto" ? w.startsWith("crypto") || w === "ai-tool" : niche === "nutrition" ? ["calc-tdee", "calc-macros", "ai-tool"].includes(w) : niche === "sport" ? ["calc-1rm", "calc-pace", "calc-hrzones", "ai-tool"].includes(w) : w === "ai-tool")));
  let widgets = list(raw?.widgets, 4, (w) => (allowed.has(w?.type) ? { type: w.type as Widget, title: clean(w.title, 60, "Herramienta"), note: clean(w.note, 140) } : null));
  widgets = widgets.filter((w, i, a) => a.findIndex((x) => x.type === w.type) === i);
  if (!widgets.length) widgets = [{ type: [...allowed][0] as Widget, title: niche === "crypto" ? "Tokens en tendencia" : "Pruébalo ahora", note: "" }];
  const hasAi = widgets.some((w) => w.type === "ai-tool");
  const ai = hasAi ? {
    label: clean(raw?.ai?.label, 40, "Generar"), placeholder: clean(raw?.ai?.placeholder, 140, "Escribe aquí…"),
    examples: list(raw?.ai?.examples, 3, (e) => clean(e, 120) || null),
    system: clean(raw?.ai?.system, 1200, `Eres la herramienta de IA de ${name}. Responde de forma útil, concreta y en el idioma del usuario.`),
  } : null;
  const archetype = ARCHETYPES.includes(raw?.archetype) ? raw.archetype : niche === "crypto" ? "terminal" : ARCHETYPES[seed % ARCHETYPES.length];
  return {
    name, tagline: clean(raw?.tagline, 90, "Producto digital de Kairo"), niche, archetype, brand,
    hero: { eyebrow: clean(raw?.hero?.eyebrow, 40, niche.toUpperCase()), title: clean(raw?.hero?.title, 90, name), subtitle: clean(raw?.hero?.subtitle, 220, clean(raw?.tagline, 220)), cta: clean(raw?.hero?.cta, 28, "Empezar") },
    features: list(raw?.features, 6, (f) => (f?.title ? { title: clean(f.title, 50), text: clean(f.text, 200) } : null)),
    steps: list(raw?.steps, 4, (f) => (f?.title ? { title: clean(f.title, 50), text: clean(f.text, 180) } : null)),
    faq: list(raw?.faq, 6, (f) => (f?.q ? { q: clean(f.q, 120), a: clean(f.a, 400) } : null)),
    widgets, ai,
    seo: { title: clean(raw?.seo?.title, 60, name), description: clean(raw?.seo?.description, 158, clean(raw?.tagline, 158)), keywords: list(raw?.seo?.keywords, 8, (k) => clean(k, 30) || null) },
    disclaimer: clean(raw?.disclaimer, 300, niche === "crypto" ? "Información con fines educativos. No es asesoramiento financiero. Las criptomonedas son muy volátiles y puedes perder todo lo invertido. Haz tu propia investigación." : niche === "nutrition" || niche === "sport" ? "Información general, no sustituye el consejo de un profesional sanitario o deportivo." : ""),
  };
}

/** Valida el concepto de meme coin del LLM (texto plano, porcentajes que suman 100). */
export function normalizeCoin(raw: any, logo: boolean): Coin {
  const list = <T,>(v: unknown, n: number, f: (x: any) => T | null): T[] => (Array.isArray(v) ? v : []).map(f).filter((x): x is T => !!x).slice(0, n);
  const ticker = clean(raw?.ticker, 8, "MEME").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8) || "MEME";
  let dist = list(raw?.tokenomics?.distribution, 6, (d) => { const pct = Number(d?.pct); return d?.label && Number.isFinite(pct) && pct > 0 ? { label: clean(d.label, 40), pct } : null; });
  const sum = dist.reduce((a, d) => a + d.pct, 0);
  if (!dist.length || sum <= 0) dist = [{ label: "Liquidez", pct: 85 }, { label: "Comunidad y airdrops", pct: 10 }, { label: "Marketing", pct: 5 }];
  else { dist = dist.map((d) => ({ ...d, pct: Math.round((d.pct / sum) * 1000) / 10 })); }
  return {
    ticker, description: clean(raw?.description, 400), lore: clean(raw?.lore, 1200),
    traits: list(raw?.traits, 5, (t) => clean(t, 60) || null),
    supply: clean(raw?.tokenomics?.supply, 30, "1.000.000.000").replace(/[^0-9.,\s]/g, "").trim() || "1.000.000.000",
    distribution: dist,
    roadmap: list(raw?.roadmap, 5, (r) => (r?.text ? { phase: clean(r.phase, 30, "Fase"), text: clean(r.text, 200) } : null)),
    community: list(raw?.community, 5, (t) => clean(t, 140) || null),
    logo,
  };
}

// ------------------------------------------------------------------ HTML
/** Variables CSS del modo de la marca + el modo contrario derivado (con contraste válido). */
function themeCss(c: Spec["brand"], f: { head: string; body: string }): string {
  const vars = (b: { bg: string; surface: string; text: string; muted: string; accent: string; accent2: string }) =>
    `--bg:${b.bg};--surface:${b.surface};--text:${b.text};--muted:${b.muted};--accent:${b.accent};--accent2:${b.accent2};--on-accent:${contrast("#000000", b.accent) >= 4.5 ? "#000000" : "#ffffff"}`;
  const fit = (accent: string, bg: string, toward: string) => { let a = accent; for (let i = 0; i < 10 && contrast(a, bg) < 3.2; i++) a = mix(a, toward, 0.18); return a; };
  const other = c.mode === "dark"
    ? { bg: "#fafaf9", surface: "#ffffff", text: "#141414", muted: "#57534e", accent: fit(c.accent, "#fafaf9", "#000000"), accent2: fit(c.accent2, "#fafaf9", "#000000") }
    : { bg: "#0b0b0d", surface: "#151518", text: "#f5f5f5", muted: "#a8a29e", accent: fit(c.accent, "#0b0b0d", "#ffffff"), accent2: fit(c.accent2, "#0b0b0d", "#ffffff") };
  const common = `--radius:${c.radius}px;--font-head:"${f.head}",system-ui,sans-serif;--font-body:"${f.body}",system-ui,sans-serif`;
  return `:root{${common};${vars(c)}}:root[data-theme="${c.mode === "dark" ? "light" : "dark"}"]{${vars(other)}}`;
}

export function renderSite(spec: Spec, slug: string, origin: string, assetVersion: string): string {
  const f = FONT_PAIRS[spec.brand.fonts];
  const coin = spec.coin ?? null;
  const url = `${origin}/s/${slug}/`;
  const c = spec.brand;
  const config = { slug, name: spec.name, niche: spec.niche, widgets: spec.widgets, ai: spec.ai ? { label: spec.ai.label, placeholder: spec.ai.placeholder, examples: spec.ai.examples } : null };
  const ld = { "@context": "https://schema.org", "@type": "WebApplication", name: spec.name, description: spec.seo.description, url, applicationCategory: spec.niche === "crypto" ? "FinanceApplication" : spec.niche === "sport" || spec.niche === "nutrition" ? "HealthApplication" : "UtilitiesApplication", operatingSystem: "Web", offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" } };
  const faqLd = spec.faq.length ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: spec.faq.map((q) => ({ "@type": "Question", name: q.q, acceptedAnswer: { "@type": "Answer", text: q.a } })) } : null;
  const json = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c");
  const widget = (w: Spec["widgets"][number], i: number) =>
    `<section class="fx-widget" data-widget="${esc(w.type)}" data-i="${i}" aria-labelledby="w${i}"><header class="fx-widget-h"><h3 id="w${i}">${esc(w.title)}</h3>${w.note ? `<p>${esc(w.note)}</p>` : ""}</header><div class="fx-widget-b" aria-live="polite"><div class="fx-skel" aria-hidden="true"></div></div></section>`;
  return `<!doctype html>
<html lang="es" data-theme="${c.mode}" class="fx a-${spec.archetype}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(spec.seo.title)}</title>
<meta name="description" content="${esc(spec.seo.description)}">
${spec.seo.keywords.length ? `<meta name="keywords" content="${esc(spec.seo.keywords.join(", "))}">` : ""}
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(spec.seo.title)}"><meta property="og:description" content="${esc(spec.seo.description)}"><meta property="og:url" content="${esc(url)}"><meta name="twitter:card" content="${coin?.logo ? "summary_large_image" : "summary"}">${coin?.logo ? `<meta property="og:image" content="${esc(url)}logo">` : ""}
<meta name="theme-color" content="${c.bg}">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='16' fill='${c.accent}'/><text x='50%' y='58%' text-anchor='middle' font-family='sans-serif' font-weight='700' font-size='34' fill='${c.bg}'>${spec.name.slice(0, 1).toUpperCase()}</text></svg>`)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${f.q}&display=swap">
<link rel="stylesheet" href="/fx-site.css?v=${assetVersion}">
<style>${themeCss(c, f)}</style>
<script type="application/ld+json">${json(ld)}</script>
${faqLd ? `<script type="application/ld+json">${json(faqLd)}</script>` : ""}
<script type="application/json" id="fx-config">${json(config)}</script>
<script src="/fx-runtime.js?v=${assetVersion}" defer></script>
</head>
<body>
<a class="fx-skip" href="#main">Saltar al contenido</a>
<header class="fx-nav"><div class="fx-wrap fx-nav-in"><a class="fx-brand" href="#top" aria-label="${esc(spec.name)} — inicio"><span class="fx-logo" aria-hidden="true">${esc(spec.name.slice(0, 1).toUpperCase())}</span>${esc(spec.name)}</a>
<nav aria-label="Secciones">${coin ? `<a href="#lore">Lore</a><a href="#tokenomics">Tokenomics</a>` : ""}<a href="#tools">${coin ? "Mercado" : "Herramienta"}</a>${spec.features.length ? `<a href="#features">Funciones</a>` : ""}${spec.faq.length ? `<a href="#faq">FAQ</a>` : ""}</nav>
<button class="fx-theme" type="button" aria-label="Cambiar tema claro/oscuro"><span aria-hidden="true"></span></button></div></header>
<main id="main">
<section class="fx-hero" id="top"><div class="fx-wrap fx-hero-in">
${coin?.logo ? `<img class="fx-coin-logo" src="logo?v=${esc(assetVersion)}" alt="Logo de ${esc(spec.name)}" width="168" height="168" decoding="async">` : ""}
<p class="fx-eyebrow">${coin ? `$${esc(coin.ticker)} · ` : ""}${esc(spec.hero.eyebrow)}</p>
<h1>${esc(spec.hero.title)}</h1>
<p class="fx-lead">${esc(spec.hero.subtitle)}</p>
<div class="fx-cta"><a class="fx-btn" href="#tools">${esc(spec.hero.cta)}</a>${spec.features.length ? `<a class="fx-btn ghost" href="#features">Ver funciones</a>` : ""}</div>
${coin ? `<p class="fx-coin-state" role="note"><b>Estado: concepto.</b> $${esc(coin.ticker)} todavía no existe en ninguna blockchain. Si alguien te ofrece comprarlo, no es este proyecto.</p>` : `<div class="fx-stats" data-stats aria-live="polite"></div>`}
</div><div class="fx-hero-art" aria-hidden="true"><i></i><i></i><i></i></div></section>
${coin ? coinSections(spec, coin) : ""}
<section class="fx-tools" id="tools" aria-label="Herramientas"><div class="fx-wrap fx-grid-w">${spec.widgets.map(widget).join("")}</div></section>
${spec.features.length ? `<section class="fx-sec" id="features"><div class="fx-wrap"><h2>Lo que hace ${esc(spec.name)}</h2><div class="fx-features">${spec.features.map((x) => `<article class="fx-card"><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p></article>`).join("")}</div></div></section>` : ""}
${spec.steps.length ? `<section class="fx-sec"><div class="fx-wrap"><h2>Cómo funciona</h2><ol class="fx-steps">${spec.steps.map((x) => `<li><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p></li>`).join("")}</ol></div></section>` : ""}
${spec.faq.length ? `<section class="fx-sec" id="faq"><div class="fx-wrap fx-narrow"><h2>Preguntas frecuentes</h2>${spec.faq.map((x) => `<details class="fx-faq"><summary>${esc(x.q)}</summary><p>${esc(x.a)}</p></details>`).join("")}</div></section>` : ""}
</main>
<footer class="fx-foot"><div class="fx-wrap"><p><b>${esc(spec.name)}</b> · ${esc(spec.tagline)}</p>${spec.disclaimer ? `<p class="fx-disc">${esc(spec.disclaimer)}</p>` : ""}<p class="fx-src">${spec.widgets.some((w) => WIDGET_DATA[w.type]) ? "Datos: DexScreener, GeckoTerminal y CoinGecko (APIs públicas), actualizados en vivo." : ""} Creado por <a href="${esc(origin)}/s/" rel="noopener">Kairo Factory</a>.</p></div></footer>
</body>
</html>`;
}

function coinSections(spec: Spec, c: Coin): string {
  const colors = ["var(--accent)", "var(--accent2)", "var(--text)", "var(--muted)", "var(--accent)", "var(--accent2)"];
  return `<section class="fx-sec" id="lore"><div class="fx-wrap fx-coin-grid"><div><h2>La historia de ${esc(spec.name)}</h2>${c.description ? `<p class="fx-lead">${esc(c.description)}</p>` : ""}${c.lore ? `<p>${esc(c.lore)}</p>` : ""}</div>${c.traits.length ? `<ul class="fx-traits" aria-label="Rasgos">${c.traits.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</div></section>
<section class="fx-sec" id="tokenomics"><div class="fx-wrap"><h2>Tokenomics propuesta</h2><p class="fx-src">Suministro total propuesto: <b>${esc(c.supply)}</b> $${esc(c.ticker)} · diseño orientativo, no desplegado.</p><div class="fx-bar" role="img" aria-label="${esc(c.distribution.map((d) => `${d.label} ${d.pct}%`).join(", "))}">${c.distribution.map((d, i) => `<span style="width:${d.pct}%;background:${colors[i % colors.length]}"></span>`).join("")}</div><ul class="fx-legend">${c.distribution.map((d, i) => `<li><i style="background:${colors[i % colors.length]}"></i>${esc(d.label)} <b>${d.pct}%</b></li>`).join("")}</ul></div></section>
${c.roadmap.length ? `<section class="fx-sec"><div class="fx-wrap"><h2>Roadmap</h2><ol class="fx-steps">${c.roadmap.map((r) => `<li><h3>${esc(r.phase)}</h3><p>${esc(r.text)}</p></li>`).join("")}</ol></div></section>` : ""}
${c.community.length ? `<section class="fx-sec"><div class="fx-wrap"><h2>Ideas para la comunidad</h2><div class="fx-features">${c.community.map((t) => `<article class="fx-card"><p>${esc(t)}</p></article>`).join("")}</div></div></section>` : ""}`;
}
