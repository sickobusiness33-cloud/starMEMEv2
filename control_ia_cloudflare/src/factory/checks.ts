// QA y seguridad automáticas (deterministas, no las decide un LLM). Un proyecto solo pasa a
// producción si TODAS las comprobaciones obligatorias salen bien.

import type { Env } from "../env";
import { DATA_ENDPOINTS, probeEndpoint } from "./data";
import { contrast, WIDGET_DATA, type Spec } from "./render";

export interface Check { id: string; ok: boolean; detail: string; required: boolean }

const has = (html: string, re: RegExp) => re.test(html);

/** QA funcional, accesibilidad, SEO y rendimiento. */
export async function qaChecks(env: Env, spec: Spec, html: string, opts: { inspiredBy?: string | null } = {}): Promise<Check[]> {
  const out: Check[] = [];
  const add = (id: string, ok: boolean, detail: string, required = true) => out.push({ id, ok, detail, required });
  // «Copia original»: la web nunca muestra el nombre de la marca que sirvió de referente.
  const ref = String(opts.inspiredBy ?? "").trim();
  // Las fuentes de datos citadas (DexScreener, CoinGecko…) no cuentan: citarlas es atribución, no copia.
  if (ref.length >= 3 && !/dexscreener|coingecko|geckoterminal/i.test(ref)) {
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<p class="fx-src">[\s\S]*?<\/p>/gi, " ").replace(/<[^>]+>/g, " ").toLowerCase();
    add("brand.original", !text.includes(ref.toLowerCase()), `Marca propia: no aparece «${ref}» (referente)`);
  }
  add("html.doctype", html.startsWith("<!doctype html>"), "Doctype HTML5");
  add("html.lang", has(html, /<html lang="[a-z]{2}"/), "Idioma declarado");
  add("html.viewport", has(html, /name="viewport"/), "Viewport móvil (mobile-first)");
  add("seo.title", spec.seo.title.length >= 10 && spec.seo.title.length <= 60, `Título SEO de ${spec.seo.title.length} caracteres (10-60)`);
  add("seo.description", spec.seo.description.length >= 50 && spec.seo.description.length <= 160, `Meta descripción de ${spec.seo.description.length} caracteres (50-160)`);
  add("seo.canonical", has(html, /rel="canonical"/), "URL canónica");
  add("seo.og", has(html, /og:title/) && has(html, /og:description/), "Open Graph");
  add("seo.jsonld", has(html, /application\/ld\+json/), "Datos estructurados (schema.org)");
  const h1 = (html.match(/<h1[\s>]/g) || []).length;
  add("a11y.h1", h1 === 1, `${h1} encabezado(s) H1 (debe haber 1)`);
  add("a11y.skip", has(html, /class="fx-skip"/), "Enlace para saltar al contenido");
  add("a11y.landmarks", has(html, /<main[\s>]/) && has(html, /<header/) && has(html, /<footer/), "Regiones header/main/footer");
  add("a11y.contrast.text", contrast(spec.brand.text, spec.brand.bg) >= 7, `Contraste texto ${contrast(spec.brand.text, spec.brand.bg).toFixed(1)}:1 (≥7)`);
  add("a11y.contrast.muted", contrast(spec.brand.muted, spec.brand.bg) >= 4.5, `Contraste secundario ${contrast(spec.brand.muted, spec.brand.bg).toFixed(1)}:1 (≥4.5)`);
  add("perf.weight", html.length < 60_000, `HTML de ${(html.length / 1024).toFixed(1)} KB (< 60 KB)`);
  add("content.value", spec.widgets.length >= 1, `${spec.widgets.length} herramienta(s) funcional(es)`);
  add("content.copy", spec.features.length >= 3 && spec.faq.length >= 3, `${spec.features.length} funciones · ${spec.faq.length} preguntas`, false);
  if (spec.coin) {
    add("coin.logo", spec.coin.logo && has(html, /class="fx-coin-logo[ "]/), "Logo propio generado (FLUX)");
    add("coin.identity", /^[A-Z0-9]{2,8}$/.test(spec.coin.ticker) && spec.coin.lore.length >= 80 && spec.coin.distribution.length >= 2, `$${spec.coin.ticker}: lore de ${spec.coin.lore.length} caracteres, ${spec.coin.distribution.length} partidas de tokenomics`);
    add("coin.honest", has(html, /class="fx-coin-state[ "]/) && /no está desplegado/i.test(spec.disclaimer), "Avisa de que es un concepto (no on-chain, no inversión)");
  }
  if (spec.widgets.some((w) => w.type === "ai-tool")) add("ai.config", !!spec.ai && spec.ai.system.length >= 40, "Herramienta de IA configurada con instrucciones");
  // Cada widget con datos: la fuente responde ahora mismo con datos válidos.
  const keys = [...new Set(spec.widgets.map((w) => WIDGET_DATA[w.type]).filter(Boolean) as string[])];
  // DexScreener/GeckoTerminal limitan las IP de Cloudflare: la web los consulta desde el navegador del visitante.
  // Desde el servidor se verifica lo que se puede; si la fuente limita al servidor, queda como aviso (no bloquea).
  for (const k of keys) {
    const r = await probeEndpoint(env, k);
    const limited = !r.ok && /429|limitada|403/.test(r.detail);
    add(`data.${k}`, r.ok, limited ? `${k}: la API limita las IP de servidor; la web la consulta desde el navegador (CORS abierto) con respaldo GeckoTerminal` : r.detail, !limited);
  }
  if (keys.length) { const m = await probeEndpoint(env, "crypto.market"); add("data.reference", m.ok, `Fuente de referencia verificada desde el servidor: ${m.detail}`); }
  return out;
}

const SECRET = /(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|cf[au]t_[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{10,}|0x[a-fA-F0-9]{64})/;
const ALLOWED_EXTERNAL = ["https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://schema.org", "https://dexscreener.com", "https://www.coingecko.com", "https://www.geckoterminal.com"];

/** Seguridad: XSS, scripts, secretos, orígenes externos, inyección. Las cabeceras (CSP sandbox, nosniff…) las pone el servidor. */
export function securityChecks(html: string): Check[] {
  const out: Check[] = [];
  const add = (id: string, ok: boolean, detail: string) => out.push({ id, ok, detail, required: true });
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
  const exec = scripts.filter((a) => !/type="application\/(ld\+)?json"/.test(a));
  add("sec.scripts", exec.length === 1 && /src="\/fx-runtime\.js\?v=[\w.-]+"/.test(exec[0] ?? ""), `Scripts ejecutables: ${exec.length} (solo el runtime auditado)`);
  const inlineCode = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].filter((m) => !/type="application\/(ld\+)?json"/.test(m[0]));
  add("sec.inline-js", inlineCode.length === 0, "Sin JavaScript inline");
  add("sec.handlers", !/\son[a-z]+\s*=/i.test(html.replace(/<script[\s\S]*?<\/script>/gi, "")), "Sin manejadores on* en el HTML (XSS)");
  add("sec.js-urls", !/(href|src|action)\s*=\s*"\s*(javascript|vbscript|data:text\/html)/i.test(html), "Sin URLs javascript:/data:");
  add("sec.forms", !/<form[^>]*action="https?:/i.test(html), "Ningún formulario envía datos a terceros");
  add("sec.iframes", !/<(iframe|object|embed)\b/i.test(html), "Sin iframes/objetos incrustados");
  add("sec.secrets", !SECRET.test(html), "Sin claves, tokens ni claves privadas en el código");
  const ext = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]).filter((u) => !ALLOWED_EXTERNAL.some((a) => u.startsWith(a)));
  const own = ext.filter((u) => !/\/s\/|\/fx/.test(u));
  add("sec.origins", own.length === 0, own.length ? `Orígenes externos no permitidos: ${own.slice(0, 3).join(", ")}` : "Solo orígenes permitidos (fuentes, datos públicos)");
  add("sec.no-cookies", !/document\.cookie|localStorage\.setItem\(["']token/i.test(html), "No accede a cookies ni guarda credenciales");
  return out;
}

export const passed = (checks: Check[]) => checks.filter((c) => c.required).every((c) => c.ok);
export const failures = (checks: Check[]) => checks.filter((c) => c.required && !c.ok).map((c) => `${c.id}: ${c.detail}`);
export { DATA_ENDPOINTS };
