// Web de lanzamiento de una meme coin (Coin Studio). Plantilla propia, pensada para "vender" el
// concepto: hero con mascota, marquesina, historia ilustrada, tokenomics con gráfico, roadmap,
// comunidad, chat con la mascota y mercado real. Mismas garantías que el resto de la fábrica:
// todo el texto escapado, cero HTML del modelo, un único script auditado (/fx-runtime.js).

import { esc, FONT_PAIRS, themeCss, WIDGET_DATA, type Coin, type Spec } from "./render";

const COLORS = ["var(--accent)", "var(--accent2)", "var(--text)", "var(--muted)", "color-mix(in srgb, var(--accent) 55%, var(--accent2))", "color-mix(in srgb, var(--accent2) 50%, var(--text))"];

/** Donut SVG (círculos con dasharray: sin paths a mano, números ya validados). */
function donut(c: Coin): string {
  let off = 25;
  const segs = c.distribution.map((d, i) => {
    const s = `<circle r="15.9155" cx="21" cy="21" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="6" stroke-dasharray="${Math.max(0, d.pct - 0.6).toFixed(2)} ${(100 - Math.max(0, d.pct - 0.6)).toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"></circle>`;
    off = (off - d.pct + 100) % 100;
    return s;
  }).join("");
  return `<svg class="cx-donut" viewBox="0 0 42 42" role="img" aria-label="${esc(c.distribution.map((d) => `${d.label} ${d.pct}%`).join(", "))}"><circle r="15.9155" cx="21" cy="21" fill="none" stroke="var(--line)" stroke-width="6"></circle>${segs}<text x="21" y="20" text-anchor="middle" class="cx-donut-t">$${esc(c.ticker)}</text><text x="21" y="25.5" text-anchor="middle" class="cx-donut-s">${esc(c.supply)}</text></svg>`;
}

export function renderCoinSite(spec: Spec, slug: string, origin: string, assetVersion: string): string {
  const c = spec.coin!;
  const f = FONT_PAIRS[spec.brand.fonts];
  const url = `${origin}/s/${slug}/`;
  const has = (n: string) => (c.images ?? []).includes(n);
  const img = (n: string, alt: string, cls: string, size = 512) => `<img class="${cls}" src="${n}?v=${esc(assetVersion)}" alt="${esc(alt)}" width="${size}" height="${size}" decoding="async"${n === "logo" ? "" : ` loading="lazy"`}>`;
  const mascot = c.mascot || spec.name;
  const slogans = (c.slogans?.length ? c.slogans : [spec.tagline, `$${c.ticker}`, mascot]).filter(Boolean);
  const marquee = Array.from({ length: 3 }, () => slogans.map((s) => `<span>${esc(s)}</span><b aria-hidden="true">✦</b>`).join("")).join("");
  const config = { slug, name: spec.name, niche: "crypto", widgets: spec.widgets, ai: spec.ai ? { label: spec.ai.label, placeholder: spec.ai.placeholder, examples: spec.ai.examples } : null };
  const ld = { "@context": "https://schema.org", "@type": "CreativeWork", name: `${spec.name} ($${c.ticker})`, description: spec.seo.description, url, image: `${url}logo`, genre: "Meme coin (concepto)", creator: { "@type": "Organization", name: "Kairo Factory" } };
  const faqLd = spec.faq.length ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: spec.faq.map((q) => ({ "@type": "Question", name: q.q, acceptedAnswer: { "@type": "Answer", text: q.a } })) } : null;
  const json = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c");
  const widget = (w: Spec["widgets"][number], i: number) =>
    `<section class="fx-widget" data-widget="${esc(w.type)}" data-i="${i}" aria-labelledby="w${i}"><header class="fx-widget-h"><h3 id="w${i}">${esc(w.title)}</h3>${w.note ? `<p>${esc(w.note)}</p>` : ""}</header><div class="fx-widget-b" aria-live="polite"><div class="fx-skel" aria-hidden="true"></div></div></section>`;
  const aiW = spec.widgets.map((w, i) => [w, i] as const).filter(([w]) => w.type === "ai-tool");
  const dataW = spec.widgets.map((w, i) => [w, i] as const).filter(([w]) => w.type !== "ai-tool");
  const stats: [string, string][] = [["Suministro", c.supply], ["Red propuesta", c.chain ?? "Solana"], ["Impuestos", c.taxes ?? "0% / 0%"], ["Estado", "Concepto"]];

  return `<!doctype html>
<html lang="es" data-theme="${spec.brand.mode}" class="fx cx cx-${c.style ?? "sticker"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(spec.seo.title)}</title>
<meta name="description" content="${esc(spec.seo.description)}">
${spec.seo.keywords.length ? `<meta name="keywords" content="${esc(spec.seo.keywords.join(", "))}">` : ""}
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(spec.seo.title)}"><meta property="og:description" content="${esc(spec.seo.description)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(url)}logo"><meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="${spec.brand.bg}">
<link rel="icon" href="logo?v=${esc(assetVersion)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${f.q}&display=swap">
<link rel="stylesheet" href="/fx-site.css?v=${assetVersion}">
<link rel="stylesheet" href="/fx-coin.css?v=${assetVersion}">
<style>${themeCss(spec.brand, f)}</style>
<script type="application/ld+json">${json(ld)}</script>
${faqLd ? `<script type="application/ld+json">${json(faqLd)}</script>` : ""}
<script type="application/json" id="fx-config">${json(config)}</script>
<script src="/fx-runtime.js?v=${assetVersion}" defer></script>
</head>
<body>
<a class="fx-skip" href="#main">Saltar al contenido</a>
<header class="cx-nav"><div class="cx-wrap cx-nav-in">
<a class="cx-brand" href="#top" aria-label="${esc(spec.name)} — inicio">${c.logo ? img("logo", "", "cx-brand-logo", 40) : ""}<span>${esc(spec.name)}</span><small>$${esc(c.ticker)}</small></a>
<nav aria-label="Secciones"><a href="#lore">Historia</a><a href="#tokenomics">Tokenomics</a><a href="#roadmap">Roadmap</a><a href="#chat">${esc(mascot)}</a></nav>
<a class="cx-btn sm" href="#community">Únete</a>
</div></header>
<main id="main">
<section class="cx-hero" id="top"><div class="cx-wrap cx-hero-in">
<div class="cx-hero-copy">
<p class="cx-eyebrow"><span class="cx-dot" aria-hidden="true"></span>$${esc(c.ticker)} · ${esc(spec.hero.eyebrow)}</p>
<h1>${esc(spec.hero.title)}</h1>
<p class="cx-lead">${esc(spec.hero.subtitle)}</p>
<div class="cx-cta"><a class="cx-btn" href="#lore">${esc(spec.hero.cta)}</a><a class="cx-btn ghost" href="#tokenomics">Ver tokenomics</a></div>
<ul class="cx-stats" aria-label="Datos del concepto">${stats.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join("")}</ul>
</div>
<div class="cx-hero-art">
<div class="cx-orbit" aria-hidden="true"></div>
${c.logo ? img("logo", `Logo de ${spec.name}, la mascota ${mascot}`, "fx-coin-logo cx-logo", 512) : ""}
${c.traits.slice(0, 3).map((t, i) => `<span class="cx-tag s${i}" aria-hidden="true">${esc(t)}</span>`).join("")}
</div>
</div>
<div class="cx-wrap"><p class="fx-coin-state cx-state" role="note"><b>Estado: concepto.</b> $${esc(c.ticker)} todavía no existe en ninguna blockchain. Si alguien te ofrece comprarlo, no es este proyecto.</p></div>
</section>
<div class="cx-marquee" aria-hidden="true"><div class="cx-marquee-in">${marquee}</div></div>
<section class="cx-sec" id="lore"><div class="cx-wrap cx-lore">
<div class="cx-lore-art">${has("art") ? img("art", `Ilustración de ${mascot}`, "cx-art") : c.logo ? img("logo", `Ilustración de ${mascot}`, "cx-art") : ""}</div>
<div class="cx-lore-txt">
<p class="cx-kicker">La historia</p>
<h2>${esc(mascot === spec.name ? `El origen de ${spec.name}` : `Conoce a ${mascot}`)}</h2>
${c.description ? `<p class="cx-lead">${esc(c.description)}</p>` : ""}
${c.lore ? c.lore.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¡¿])/).reduce<string[]>((a, s, i) => { const k = Math.floor(i / 3); a[k] = (a[k] ? a[k] + " " : "") + s; return a; }, []).map((p) => `<p>${esc(p)}</p>`).join("") : ""}
${c.traits.length ? `<ul class="cx-traits" aria-label="Rasgos de ${esc(mascot)}">${c.traits.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
</div></div></section>
<section class="cx-sec cx-alt" id="tokenomics"><div class="cx-wrap">
<p class="cx-kicker">Tokenomics propuesta</p><h2>Un reparto simple y transparente</h2>
<div class="cx-tok">
<div class="cx-tok-chart">${donut(c)}</div>
<div><ul class="cx-legend">${c.distribution.map((d, i) => `<li class="cx-card"><i style="background:${COLORS[i % COLORS.length]}"></i><span>${esc(d.label)}</span><b>${d.pct}%</b><span class="cx-meter"><span style="width:${d.pct}%;background:${COLORS[i % COLORS.length]}"></span></span></li>`).join("")}</ul>
<p class="cx-note">Suministro total propuesto: <b>${esc(c.supply)}</b> $${esc(c.ticker)} · red propuesta: ${esc(c.chain ?? "Solana")} · impuestos compra/venta: ${esc(c.taxes ?? "0% / 0%")}. Diseño orientativo: nada está desplegado.</p></div>
</div></div></section>
${c.roadmap.length ? `<section class="cx-sec" id="roadmap"><div class="cx-wrap"><p class="cx-kicker">Roadmap</p><h2>El plan de ${esc(mascot)}</h2><ol class="cx-road">${c.roadmap.map((r, i) => `<li class="cx-card"><span class="cx-step">${String(i + 1).padStart(2, "0")}</span><h3>${esc(r.phase)}</h3><p>${esc(r.text)}</p></li>`).join("")}</ol></div></section>` : ""}
<section class="cx-sec cx-alt" id="community"><div class="cx-wrap cx-comm">
<div><p class="cx-kicker">Comunidad</p><h2>Memes, retos y cultura</h2>${c.community.length ? `<ul class="cx-ideas">${c.community.map((t) => `<li class="cx-card">${esc(t)}</li>`).join("")}</ul>` : ""}</div>
${has("meme") ? `<figure class="cx-meme">${img("meme", `Meme de ${mascot}`, "cx-art")}<figcaption>${esc(slogans[0] ?? spec.tagline)}</figcaption></figure>` : ""}
</div></section>
${aiW.length ? `<section class="cx-sec" id="chat"><div class="cx-wrap cx-narrow"><p class="cx-kicker">En personaje</p><h2>Habla con ${esc(mascot)}</h2>${aiW.map(([w, i]) => widget(w, i)).join("")}</div></section>` : ""}
${dataW.length ? `<section class="cx-sec cx-alt" id="market"><div class="cx-wrap"><p class="cx-kicker">Datos reales</p><h2>El mercado meme ahora</h2>${dataW.map(([w, i]) => widget(w, i)).join("")}</div></section>` : ""}
${spec.faq.length ? `<section class="cx-sec" id="faq"><div class="cx-wrap cx-narrow"><p class="cx-kicker">FAQ</p><h2>Preguntas frecuentes</h2>${spec.faq.map((x) => `<details class="fx-faq cx-card"><summary>${esc(x.q)}</summary><p>${esc(x.a)}</p></details>`).join("")}</div></section>` : ""}
</main>
<footer class="cx-foot"><div class="cx-wrap">
<div class="cx-foot-top"><a class="cx-brand" href="#top">${c.logo ? img("logo", "", "cx-brand-logo", 40) : ""}<span>${esc(spec.name)}</span><small>$${esc(c.ticker)}</small></a><p>${esc(spec.tagline)}</p></div>
${spec.disclaimer ? `<p class="fx-disc">${esc(spec.disclaimer)}</p>` : ""}
<p class="fx-src">${spec.widgets.some((w) => WIDGET_DATA[w.type]) ? "Datos de mercado: DexScreener, GeckoTerminal y CoinGecko (APIs públicas). " : ""}Creado por <a href="${esc(origin)}/s/" rel="noopener">Kairo Factory</a> · Coin Studio.</p>
</div></footer>
</body>
</html>`;
}
