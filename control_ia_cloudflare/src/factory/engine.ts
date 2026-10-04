// Motor de la Autonomous Project Factory.
//
//   BACKLOG → RESEARCH → BUILDING → TESTING → SECURITY → DEPLOYING → LIVE → MAINTENANCE
//
// Cada etapa la hace un agente distinto (rol + modelo adecuado). Las decisiones de calidad y
// seguridad son deterministas (checks.ts); el LLM investiga, decide el producto y escribe.
// Corre en la cola + cron de Cloudflare: funciona sin navegador abierto.

import { RouterError } from "../ai/errors";
import { generate, isQuotaError, routeImage, type CallContext } from "../ai/router";
import { bytesToB64 } from "../b64";
import { instantiate } from "../connectors";
import type { GitHubConnector } from "../connectors/github";
import { all, dumps, loads, nowIso, one, run } from "../db";
import type { Env } from "../env";
import { getSubscription } from "../plans";
import { failures, passed, qaChecks, securityChecks } from "./checks";
import { cryptoMarket, cryptoTrending } from "./data";
import { ensureFactorySchema } from "./schema";
import { NICHES, normalizeCoin, normalizeSpec, renderSite, WIDGETS, type Spec } from "./render";

export const STAGES = ["backlog", "research", "building", "testing", "security", "deploying", "live", "maintenance"] as const;
export type Stage = (typeof STAGES)[number];

/** Los agentes de la fábrica: cada uno con su responsabilidad y su modelo. */
export const FX_AGENTS = [
  { id: "research", name: "Research", stage: "research", does: "Investiga el nicho con datos reales y propone ideas" },
  { id: "product", name: "Product", stage: "research", does: "Valida la idea: público, valor, riesgo y monetización" },
  { id: "architect", name: "Architecture", stage: "building", does: "Define estructura, widgets y fuentes de datos" },
  { id: "uiux", name: "UI/UX", stage: "building", does: "Identidad visual propia: paleta, tipografía, layout" },
  { id: "frontend", name: "Frontend", stage: "building", does: "Construye la web accesible y mobile-first" },
  { id: "backend", name: "Backend", stage: "building", does: "Conecta APIs reales y la herramienta de IA" },
  { id: "database", name: "Database", stage: "building", does: "Registro del proyecto y versiones" },
  { id: "marketing", name: "Marketing", stage: "building", does: "Copy, propuesta de valor y CTA" },
  { id: "testing", name: "Testing", stage: "testing", does: "Prueba rutas, widgets y fuentes de datos" },
  { id: "qa", name: "QA", stage: "testing", does: "Accesibilidad, contraste, SEO y peso" },
  { id: "security", name: "Security", stage: "security", does: "XSS, secretos, orígenes, scripts e inyección" },
  { id: "seo", name: "SEO", stage: "deploying", does: "Meta, Open Graph, schema.org, sitemap" },
  { id: "devops", name: "DevOps", stage: "deploying", does: "Publica la versión y exporta a GitHub" },
  { id: "deploy", name: "Deployment", stage: "deploying", does: "Verifica la URL publicada" },
  { id: "docs", name: "Documentation", stage: "deploying", does: "README del proyecto" },
  { id: "monitor", name: "Monitoring", stage: "maintenance", does: "Re-audita cada día y repara" },
] as const;

const MAX_ATTEMPTS = 3;
const LEASE_MS = 8 * 60_000;
const assetVersion = "202610042";
const todayIso = () => new Date().toISOString().slice(0, 10);
const origin = (env: Env) => (env.PUBLIC_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
export const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
const slugify = (s: string) => norm(s).replace(/ /g, "-").slice(0, 40) || "proyecto";

export async function fxEmit(env: Env, userId: number, projectId: number | null, stage: string, agent: string, kind: string, message: string) {
  await run(env.DB, "INSERT INTO fx_events (user_id, project_id, stage, agent, kind, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", userId, projectId, stage, agent, kind, message.slice(0, 600), nowIso());
}

export async function fxSettings(env: Env, userId: number) {
  await ensureFactorySchema(env.DB);
  let s = await one<any>(env.DB, "SELECT * FROM fx_settings WHERE user_id = ?", userId);
  if (!s) {
    await run(env.DB, "INSERT OR IGNORE INTO fx_settings (user_id, niches_json, updated_at) VALUES (?, ?, ?)", userId,
      dumps([{ id: "crypto", weight: 5, enabled: true }, { id: "ai", weight: 5, enabled: true }, { id: "nutrition", weight: 1, enabled: true }, { id: "sport", weight: 1, enabled: true }]), nowIso());
    s = await one<any>(env.DB, "SELECT * FROM fx_settings WHERE user_id = ?", userId);
  }
  return { ...s, enabled: Boolean(s.enabled), auto_ideas: Boolean(s.auto_ideas), niches: loads<any[]>(s.niches_json, []) };
}

export async function fxTokensToday(env: Env, userId: number): Promise<number> {
  const r = await one<any>(env.DB, "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM usage_events WHERE user_id = ? AND kind = 'factory' AND created_at >= ?", userId, todayIso());
  return Number(r?.n ?? 0);
}

async function ctx(env: Env, userId: number, role: string, projectId: number): Promise<CallContext> {
  const sub = await getSubscription(env.DB, userId);
  return { env, userId, plan: sub.plan, kind: "factory", agentId: `factory:${role}`, agentRunId: projectId };
}
function parseJson(text: string): any | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
const SAFE = "Nunca inventes métricas, cifras de usuarios, testimonios ni precios: si algo depende de datos, la web los cargará en vivo de APIs reales. Nada de promesas de rentabilidad.";

async function ask(env: Env, userId: number, role: string, projectId: number, system: string, prompt: string, opts: { maxTokens?: number; capability?: "chat" | "reasoning" | "code"; cheap?: boolean; premium?: boolean } = {}) {
  const res = await generate(await ctx(env, userId, role, projectId), {
    system: `[factory:${role}] ${system}\n${SAFE}\nResponde SOLO con un JSON válido.`,
    messages: [{ role: "user", content: prompt }], maxTokens: opts.maxTokens ?? 1600,
    prefer: opts.premium ? "premium" : "free", allowFallback: true, capability: opts.capability ?? "chat", cheap: opts.cheap,
  });
  return { json: parseJson(res.text), model: res.model, provider: res.provider };
}

// ------------------------------------------------------------------ ideas (Research)
async function marketContext(env: Env, niche: string): Promise<string> {
  if (niche !== "crypto" || env.AI_MODE === "mock") return "";
  try {
    const rows = await cryptoTrending();
    const fmt = (n: number | null) => (n == null ? "?" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toFixed(2));
    return "DATOS REALES AHORA (DexScreener, tokens con boost): " + rows.slice(0, 12).map((r) => `${r.symbol}/${r.chain} vol24h $${fmt(r.volume24h)} liq $${fmt(r.liquidityUsd)} mcap $${fmt(r.marketCap)} ${r.change.h24 ?? "?"}%`).join("; ");
  } catch {
    try {
      const m = await cryptoMarket();
      return "DATOS REALES AHORA (CoinGecko, tendencias): " + m.coins.slice(0, 12).map((c: any) => `${c.symbol} $${c.priceUsd ?? "?"} ${c.change24h != null ? c.change24h.toFixed(1) : "?"}% rank ${c.rank ?? "?"}`).join("; ");
    } catch { return ""; }
  }
}

export async function ideate(env: Env, userId: number, niche: string, count: number, hint = "", missionId: number | null = null): Promise<number> {
  await ensureFactorySchema(env.DB);
  niche = NICHES.includes(niche) ? niche : "other";
  const existing = await all<any>(env.DB, "SELECT name FROM fx_projects WHERE user_id = ? AND niche = ? ORDER BY id DESC LIMIT 60", userId, niche);
  const widgets = WIDGETS.filter((w) => (niche === "crypto" ? w.startsWith("crypto") || w === "ai-tool" : niche === "nutrition" ? ["calc-tdee", "calc-macros", "ai-tool"].includes(w) : niche === "sport" ? ["calc-1rm", "calc-pace", "calc-hrzones", "ai-tool"].includes(w) : w === "ai-tool"));
  await fxEmit(env, userId, null, "backlog", "research", "start", `Buscando ${count} ideas de ${niche}${hint ? ` («${hint.slice(0, 80)}»)` : ""}.`);
  const { json } = await ask(env, userId, "research", 0,
    "Eres el agente Research de una fábrica de productos web. Propones micro-SaaS/herramientas web útiles, concretas y diferenciadas que se puedan construir con los widgets disponibles.",
    `Nicho: ${niche}. ${hint ? `Indicación del dueño: ${hint}.` : ""}\n${await marketContext(env, niche)}\nWidgets disponibles (la web DEBE basarse en ellos): ${widgets.join(", ")}.\nYa existen (no repitas): ${existing.map((e) => e.name).join(", ") || "ninguno"}.\n` +
    `Propón ${count} ideas distintas. JSON: {"ideas":[{"name":"nombre de marca corto y original","idea":"qué problema resuelve y para quién, 1-2 frases","widgets":["..."]}]}`,
    { capability: "reasoning", premium: true, maxTokens: 1400 });
  let created = 0;
  for (const it of (Array.isArray(json?.ideas) ? json.ideas : []).slice(0, count)) {
    const name = String(it?.name ?? "").replace(/[<>]/g, "").trim().slice(0, 40);
    const idea = String(it?.idea ?? "").replace(/[<>]/g, "").trim().slice(0, 400);
    if (name.length < 3 || idea.length < 10) continue;
    let slug = slugify(name);
    if (await one(env.DB, "SELECT 1 FROM fx_projects WHERE slug = ?", slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO fx_projects (user_id, slug, name, niche, idea, dedupe_key, stage, status, priority, research_json, mission_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'backlog', 'queued', ?, ?, ?, 'website', ?, ?)")
      .bind(userId, slug, name, niche, idea, norm(name), niche === "crypto" || niche === "ai" ? 8 : 5, dumps({ widgets: Array.isArray(it.widgets) ? it.widgets.slice(0, 4) : [] }), missionId, nowIso(), nowIso()).run();
    if (ins.meta.changes) { created++; await fxEmit(env, userId, Number(ins.meta.last_row_id), "backlog", "research", "idea", `Nueva idea: ${name} — ${idea.slice(0, 160)}`); }
  }
  return created;
}

// ------------------------------------------------------------------ meme coins (concepto + logo; nunca se despliega on-chain sin el dueño)
export async function ideateCoins(env: Env, userId: number, prompt: string, count: number, missionId: number | null): Promise<number> {
  await ensureFactorySchema(env.DB);
  const existing = await all<any>(env.DB, "SELECT name, json_extract(research_json, '$.ticker') AS ticker FROM fx_projects WHERE user_id = ? AND kind = 'memecoin' ORDER BY id DESC LIMIT 120", userId);
  await fxEmit(env, userId, null, "backlog", "research", "start", `Inventando ${count} meme coin(s) nuevas («${prompt.slice(0, 80)}»).`);
  const { json } = await ask(env, userId, "coins", 0,
    "Eres el director creativo de un estudio de meme coins. Inventas conceptos originales, graciosos y con potencial viral (mascota, chiste central, comunidad), sin copiar marcas ni personas reales y sin prometer rentabilidad.",
    `Orden del dueño: ${prompt}\n${await marketContext(env, "crypto")}\nYa existen (no repitas nombre ni ticker): ${existing.map((e) => `${e.name} ($${e.ticker ?? "?"})`).join(", ") || "ninguna"}.\n` +
    `Propón ${count} meme coins distintas. JSON: {"coins":[{"name":"nombre corto y pegadizo","ticker":"3-6 letras","idea":"la mascota y el chiste en 1-2 frases"}]}`,
    { capability: "reasoning", premium: true, maxTokens: 1200 });
  let created = 0;
  for (const it of (Array.isArray(json?.coins) ? json.coins : []).slice(0, count)) {
    const name = String(it?.name ?? "").replace(/[<>]/g, "").trim().slice(0, 40);
    const ticker = String(it?.ticker ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
    const idea = String(it?.idea ?? "").replace(/[<>]/g, "").trim().slice(0, 400);
    if (name.length < 2 || ticker.length < 2 || idea.length < 10) continue;
    if (existing.some((e) => String(e.ticker ?? "").toUpperCase() === ticker)) continue;
    let slug = slugify(`${name}-coin`);
    if (await one(env.DB, "SELECT 1 FROM fx_projects WHERE slug = ?", slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO fx_projects (user_id, slug, name, niche, idea, dedupe_key, stage, status, priority, research_json, mission_id, kind, created_at, updated_at) VALUES (?, ?, ?, 'crypto', ?, ?, 'backlog', 'queued', 8, ?, ?, 'memecoin', ?, ?)")
      .bind(userId, slug, name, idea, `coin ${norm(ticker)}`, dumps({ ticker }), missionId, nowIso(), nowIso()).run();
    if (ins.meta.changes) { created++; existing.push({ name, ticker }); await fxEmit(env, userId, Number(ins.meta.last_row_id), "backlog", "research", "idea", `Nueva meme coin: ${name} ($${ticker}) — ${idea.slice(0, 160)}`); }
  }
  return created;
}

/** Construye la meme coin: identidad, lore, tokenomics propuesta, logo (FLUX) y su web. */
async function buildCoin(env: Env, p: any) {
  const r = loads<any>(p.research_json, {});
  await fxEmit(env, p.user_id, p.id, "building", "marketing", "start", `Escribiendo identidad, lore y tokenomics de $${r.ticker ?? "?"}.`);
  const { json, model } = await ask(env, p.user_id, "coin", p.id,
    "Eres el estudio creativo de una fábrica de meme coins: naming, lore, branding, tokenomics orientativa y comunidad. Tono divertido pero profesional. Prohibido prometer rentabilidad, precios u objetivos de mercado.",
    `Concepto: ${p.name} ($${r.ticker ?? ""}) — ${p.idea}\n${p.feedback ? `CORRIGE ESTO DEL INTENTO ANTERIOR: ${p.feedback}\n` : ""}` +
    `JSON: {"name":"...","ticker":"...","tagline":"≤90","description":"2-3 frases","lore":"historia del meme, 80-140 palabras","traits":["3-5 rasgos de la mascota"],"tokenomics":{"supply":"p. ej. 1.000.000.000","distribution":[{"label":"...","pct":número}]},"roadmap":[{"phase":"Fase 1","text":"..."}×3-4],"community":["ideas de memes y contenido"×3-5],"logo_prompt":"descripción visual EN INGLÉS de la mascota (colores, estilo, expresión)","ai":{"label":"Habla con la mascota","placeholder":"...","examples":["..."],"system":"personalidad de la mascota para un chat divertido"},"brand":{"bg":"#hex","surface":"#hex","text":"#hex","muted":"#hex","accent":"#hex","accent2":"#hex","fonts":"unbounded|syne|bricolage|grotesk|sora","radius":0-28,"mode":"dark|light"},"hero":{"eyebrow":"≤40","title":"≤90","subtitle":"≤200","cta":"≤24"},"faq":[{"q":"...","a":"..."}×4],"seo":{"title":"10-60 caracteres","description":"50-155 caracteres","keywords":["..."]}}`,
    { capability: "reasoning", premium: true, maxTokens: 2600 });
  if (!json) throw new Error("El estudio creativo no devolvió un concepto válido.");
  await fxEmit(env, p.user_id, p.id, "building", "uiux", "start", "Dibujando el logo con FLUX.");
  const look = String(json.logo_prompt ?? p.idea).replace(/[\r\n]+/g, " ").slice(0, 600);
  const img = await routeImage(await ctx(env, p.user_id, "logo", p.id), {
    mode: "t2i", width: 512, height: 512,
    prompt: `${look}. Meme coin mascot logo: one character, centered, inside a round coin emblem, bold clean vector illustration, thick outlines, vibrant saturated colors, plain solid background, high contrast, iconic, no text, no letters, no watermark`,
  });
  await run(env.DB, "INSERT OR REPLACE INTO fx_assets (project_id, name, mime, data_b64, model, created_at) VALUES (?, 'logo', ?, ?, ?, ?)", p.id, img.mime, bytesToB64(img.bytes), img.model, nowIso());
  const ticker = String(json.ticker ?? r.ticker ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8) || r.ticker;
  const raw = {
    ...json, ticker, archetype: ["spotlight", "bento", "editorial"][p.id % 3],
    widgets: [{ type: "ai-tool", title: String(json.ai?.label ?? "Habla con la mascota") }, { type: "crypto-trending", title: "El mercado meme ahora", note: "Datos reales en vivo de DexScreener/GeckoTerminal, para contexto." }],
    ai: { ...(json.ai ?? {}), system: `${String(json.ai?.system ?? "")} Eres la mascota de la meme coin ${json.name ?? p.name} ($${ticker}). Respondes con humor y en personaje. El token es un concepto: no está lanzado, no tiene precio y no se puede comprar; dilo si preguntan.`.trim() },
    features: [], steps: [],
    disclaimer: `$${ticker} es un concepto creativo generado por Kairo Factory. No está desplegado en ninguna blockchain, no tiene precio ni valor y nada aquí es una oferta de inversión ni asesoramiento financiero.`,
  };
  const spec = normalizeSpec(raw, "crypto", p.id);
  spec.coin = normalizeCoin({ ...json, ticker }, true);
  const html = renderSite(spec, p.slug, origin(env), assetVersion);
  await run(env.DB, "UPDATE fx_projects SET name = ?, spec_json = ?, html = ?, apis_json = ?, research_json = ? WHERE id = ?", spec.name, dumps(spec), html, dumps(["FLUX.1 schnell (logo)", "Kairo AI (mascota)", "DexScreener API"]), dumps({ ...r, ticker, model }), p.id);
  await fxEmit(env, p.user_id, p.id, "building", "frontend", "tool", `$${ticker} lista: logo (${img.model.split("/").pop()}), lore, tokenomics, roadmap y web (${(html.length / 1024).toFixed(1)} KB).`);
  await advance(env, p, "testing");
}

// ------------------------------------------------------------------ misiones: órdenes permanentes que se repiten cada día
/** Rellena el cupo diario de cada misión activa (por tandas de 3 para no saturar la cola). */
export async function missionTick(env: Env, userId: number, onlyId?: number): Promise<number> {
  await ensureFactorySchema(env.DB);
  const ms = await all<any>(env.DB, `SELECT * FROM fx_missions WHERE user_id = ? AND active = 1${onlyId ? " AND id = ?" : ""} ORDER BY id`, userId, ...(onlyId ? [onlyId] : []));
  let total = 0;
  for (const m of ms) {
    const made = (await one<any>(env.DB, "SELECT COUNT(*) AS n FROM fx_projects WHERE mission_id = ? AND created_at >= ? AND status NOT IN ('rejected','failed')", m.id, todayIso()))?.n ?? 0;
    const open = (await one<any>(env.DB, "SELECT COUNT(*) AS n FROM fx_projects WHERE mission_id = ? AND stage NOT IN ('live','maintenance') AND status NOT IN ('failed','rejected','paused')", m.id))?.n ?? 0;
    if (made >= m.per_day || open >= 3) continue;
    const n = Math.min(3 - open, m.per_day - made);
    try {
      const created = m.kind === "memecoin" ? await ideateCoins(env, userId, m.prompt, n, m.id) : await ideate(env, userId, m.niche, n, m.prompt, m.id);
      total += created;
      await run(env.DB, "UPDATE fx_missions SET last_at = ? WHERE id = ?", nowIso(), m.id);
      const q = await all<any>(env.DB, "SELECT id FROM fx_projects WHERE mission_id = ? AND stage = 'backlog' AND status = 'queued' ORDER BY id DESC LIMIT ?", m.id, Math.max(created, 1));
      for (const p of q) await env.RUNS.send({ fxStep: p.id });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await fxEmit(env, userId, null, "backlog", "research", (err instanceof RouterError && err.code === "free_quota") || isQuotaError(msg) ? "limit" : "error", `Misión «${m.title}»: ${msg.slice(0, 200)}`);
    }
  }
  return total;
}

// ------------------------------------------------------------------ pipeline
async function advance(env: Env, p: any, stage: Stage, fields: Record<string, unknown> = {}, delay = 0) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  await run(env.DB, `UPDATE fx_projects SET stage = ?, status = ${stage === "live" ? "'ok'" : "'queued'"}, attempts = 0, feedback = NULL, lease_until = NULL, updated_at = ?${sets ? ", " + sets : ""} WHERE id = ?`, stage, nowIso(), ...Object.values(fields), p.id);
  if (stage !== "live") await env.RUNS.send({ fxStep: p.id }, delay ? { delaySeconds: delay } : undefined);
}

async function fail(env: Env, p: any, agent: string, reason: string, quota: boolean) {
  if (quota) {
    await run(env.DB, "UPDATE fx_projects SET status = 'waiting', errors = ?, lease_until = NULL, updated_at = ? WHERE id = ?", "Esperando cupo de IA", nowIso(), p.id);
    await fxEmit(env, p.user_id, p.id, p.stage, agent, "limit", "Sin cupo de IA ahora mismo: continúa solo cuando haya.");
    return;
  }
  const attempts = (p.attempts ?? 0) + 1;
  if (attempts < MAX_ATTEMPTS) {
    await run(env.DB, "UPDATE fx_projects SET status = 'queued', attempts = ?, feedback = ?, errors = ?, lease_until = NULL, updated_at = ? WHERE id = ?", attempts, reason.slice(0, 1500), reason.slice(0, 500), nowIso(), p.id);
    await fxEmit(env, p.user_id, p.id, p.stage, agent, "retry", `Reintento ${attempts + 1}/${MAX_ATTEMPTS}: ${reason.slice(0, 200)}`);
    await env.RUNS.send({ fxStep: p.id }, { delaySeconds: env.AI_MODE === "mock" ? 1 : 30 });
  } else {
    await run(env.DB, "UPDATE fx_projects SET status = 'failed', errors = ?, lease_until = NULL, updated_at = ? WHERE id = ?", reason.slice(0, 800), nowIso(), p.id);
    await fxEmit(env, p.user_id, p.id, p.stage, agent, "error", `Detenido tras ${MAX_ATTEMPTS} intentos: ${reason.slice(0, 240)}`);
  }
}

/** Procesa la etapa actual de un proyecto (un mensaje de la cola). */
export async function fxStep(env: Env, id: number) {
  await ensureFactorySchema(env.DB);
  const lease = await env.DB.prepare("UPDATE fx_projects SET status = 'working', lease_until = ?, updated_at = ? WHERE id = ? AND status IN ('queued','waiting')")
    .bind(new Date(Date.now() + LEASE_MS).toISOString(), nowIso(), id).run();
  if (!lease.meta.changes) return;
  const p = await one<any>(env.DB, "SELECT * FROM fx_projects WHERE id = ?", id);
  const s = await fxSettings(env, p.user_id);
  const release = (status = "queued") => run(env.DB, "UPDATE fx_projects SET status = ?, lease_until = NULL WHERE id = ?", status, id);
  if (!s.enabled && p.stage !== "maintenance") { await release("paused"); return; }
  const working = (await one<any>(env.DB, "SELECT COUNT(*) AS n FROM fx_projects WHERE user_id = ? AND status = 'working' AND id != ?", p.user_id, id))?.n ?? 0;
  if (working >= s.max_parallel) { await release(); await env.RUNS.send({ fxStep: id }, { delaySeconds: 20 }); return; }
  if ((await fxTokensToday(env, p.user_id)) >= s.token_budget_day) {
    await release("waiting");
    await fxEmit(env, p.user_id, id, p.stage, "devops", "limit", "Presupuesto diario de tokens alcanzado: sigue mañana.");
    return;
  }
  let agent = "research";
  try {
    switch (p.stage as Stage) {
      case "backlog":
        agent = "research";
        if (p.kind === "memecoin") { await advance(env, p, "building"); return; }
        await fxEmit(env, p.user_id, id, "research", "research", "start", `Investigando «${p.name}».`);
        await advance(env, p, "research");
        return;
      case "research": {
        agent = "product";
        const data = await marketContext(env, p.niche);
        const { json, model } = await ask(env, p.user_id, "product", id,
          "Eres el agente Product. Validas si una idea merece convertirse en producto: público real, valor diferencial, viabilidad técnica con los widgets disponibles, riesgos y monetización legítima.",
          `Idea: ${p.name} — ${p.idea}\nNicho: ${p.niche}\n${data}\n${p.feedback ? `Revisión previa: ${p.feedback}\n` : ""}JSON: {"go":true|false,"score":1-10,"audience":"...","value":"...","risks":["..."],"monetization":["..."],"why":"1 frase"}`,
          { capability: "reasoning", premium: true, maxTokens: 700 });
        if (!json) throw new Error("Product no devolvió una validación válida.");
        const score = Math.max(0, Math.min(10, Number(json.score) || 0));
        await run(env.DB, "UPDATE fx_projects SET research_json = ? WHERE id = ?", dumps({ ...loads(p.research_json, {}), ...json, score, model, market: data.slice(0, 1500) }), id);
        if (!json.go || score < 6) {
          await run(env.DB, "UPDATE fx_projects SET stage = 'backlog', status = 'rejected', lease_until = NULL, errors = ?, updated_at = ? WHERE id = ?", `Descartada (puntuación ${score}/10): ${String(json.why ?? "").slice(0, 300)}`, nowIso(), id);
          await fxEmit(env, p.user_id, id, "research", "product", "decision", `✗ Descartada «${p.name}» (${score}/10): ${String(json.why ?? "").slice(0, 200)}`);
          return;
        }
        await fxEmit(env, p.user_id, id, "research", "product", "decision", `✓ Aprobada «${p.name}» (${score}/10) para ${String(json.audience ?? "").slice(0, 120)}`);
        await advance(env, p, "building");
        return;
      }
      case "building": {
        if (p.kind === "memecoin") { agent = "marketing"; await buildCoin(env, p); return; }
        agent = "architect";
        const research = loads<any>(p.research_json, {});
        const allowed = WIDGETS.filter((w) => (p.niche === "crypto" ? w.startsWith("crypto") || w === "ai-tool" : p.niche === "nutrition" ? ["calc-tdee", "calc-macros", "ai-tool"].includes(w) : p.niche === "sport" ? ["calc-1rm", "calc-pace", "calc-hrzones", "ai-tool"].includes(w) : w === "ai-tool"));
        await fxEmit(env, p.user_id, id, "building", "architect", "start", "Definiendo arquitectura, widgets y fuentes de datos.");
        const product = await ask(env, p.user_id, "architect", id,
          "Eres el agente Architecture + Marketing. Diseñas el producto web: estructura, herramientas funcionales (widgets) y todo el copy en español, claro y persuasivo sin exagerar.",
          `Producto: ${p.name} — ${p.idea}\nPúblico: ${research.audience ?? "?"} · Valor: ${research.value ?? "?"}\nWidgets permitidos: ${allowed.join(", ")} (crypto-* usan datos reales de DexScreener/CoinGecko; ai-tool llama a un modelo de IA con tu "system"; calc-* son calculadoras con fórmulas publicadas).\n${p.feedback ? `CORRIGE ESTO DEL INTENTO ANTERIOR: ${p.feedback}\n` : ""}` +
          `JSON: {"name":"...","tagline":"≤90","archetype":"terminal|editorial|bento|spotlight|split","widgets":[{"type":"...","title":"...","note":"..."}],"ai":{"label":"...","placeholder":"...","examples":["..."],"system":"instrucciones detalladas de la herramienta de IA"},"features":[{"title":"...","text":"..."}×4-6],"steps":[{"title":"...","text":"..."}×3],"faq":[{"q":"...","a":"..."}×4-5],"seo":{"title":"10-60 caracteres","description":"50-155 caracteres","keywords":["..."]},"disclaimer":"..."}`,
          { capability: "reasoning", premium: true, maxTokens: 2600 });
        if (!product.json) throw new Error("Architecture no devolvió una especificación válida.");
        agent = "uiux";
        await fxEmit(env, p.user_id, id, "building", "uiux", "start", "Creando identidad visual propia.");
        const brand = await ask(env, p.user_id, "uiux", id,
          "Eres el agente UI/UX. Creas una identidad visual premium y única (no plantillas genéricas): paleta con buen contraste, tipografía y tono del hero.",
          `Producto: ${product.json.name ?? p.name} — ${product.json.tagline ?? p.idea}\nNicho: ${p.niche}\nTipografías disponibles: geist, grotesk, sora, syne, unbounded, fraunces, instrument, bricolage, outfit, archivo.\n` +
          `JSON: {"brand":{"bg":"#hex","surface":"#hex","text":"#hex","muted":"#hex","accent":"#hex","accent2":"#hex","fonts":"...","radius":0-28,"mode":"dark|light"},"hero":{"eyebrow":"≤40","title":"≤90, potente","subtitle":"≤200","cta":"≤24"}}`,
          { capability: "chat", premium: true, maxTokens: 600 });
        agent = "frontend";
        const spec = normalizeSpec({ ...product.json, ...(brand.json ?? {}) }, p.niche, p.id);
        const html = renderSite(spec, p.slug, origin(env), assetVersion);
        agent = "backend";
        const apis = [...new Set(spec.widgets.map((w) => (w.type === "crypto-market" ? "CoinGecko API" : w.type.startsWith("crypto") ? "DexScreener API" : w.type === "ai-tool" ? "Kairo AI (Workers AI)" : "Cálculo local")))];
        await run(env.DB, "UPDATE fx_projects SET name = ?, spec_json = ?, html = ?, apis_json = ? WHERE id = ?", spec.name, dumps(spec), html, dumps(apis), id);
        await fxEmit(env, p.user_id, id, "building", "frontend", "tool", `Web construida: ${spec.archetype}, ${spec.brand.fonts}, ${spec.widgets.map((w) => w.type).join(" + ")} (${(html.length / 1024).toFixed(1)} KB).`);
        await fxEmit(env, p.user_id, id, "building", "backend", "tool", `APIs conectadas: ${apis.join(", ")}.`);
        await advance(env, p, "testing");
        return;
      }
      case "testing": {
        agent = "qa";
        const spec = loads<Spec>(p.spec_json, null as any);
        const checks = await qaChecks(env, spec, p.html ?? "");
        await run(env.DB, "UPDATE fx_projects SET checks_json = ? WHERE id = ?", dumps({ ...loads(p.checks_json, {}), qa: checks, qa_at: nowIso() }), id);
        const bad = failures(checks);
        await fxEmit(env, p.user_id, id, "testing", "testing", "tool", `${checks.filter((c) => c.ok).length}/${checks.length} pruebas superadas.`);
        if (!passed(checks)) return backToBuild(env, p, "qa", `QA: ${bad.join("; ")}`);
        await advance(env, p, "security");
        return;
      }
      case "security": {
        agent = "security";
        const checks = securityChecks(p.html ?? "");
        await run(env.DB, "UPDATE fx_projects SET checks_json = ? WHERE id = ?", dumps({ ...loads(p.checks_json, {}), security: checks, security_at: nowIso() }), id);
        await fxEmit(env, p.user_id, id, "security", "security", "tool", `${checks.filter((c) => c.ok).length}/${checks.length} controles de seguridad superados.`);
        if (!passed(checks)) return backToBuild(env, p, "security", `Seguridad: ${failures(checks).join("; ")}`);
        await advance(env, p, "deploying");
        return;
      }
      case "deploying": {
        agent = "devops";
        const url = `${origin(env)}/s/${p.slug}/`;
        await run(env.DB, "UPDATE fx_projects SET prev_html = CASE WHEN version > 0 THEN prev_html ELSE NULL END, version = version + 1, url = ?, live_at = COALESCE(live_at, ?), last_audit_at = ? WHERE id = ?", url, nowIso(), nowIso(), id);
        await fxEmit(env, p.user_id, id, "deploying", "seo", "tool", "Meta, Open Graph, schema.org y sitemap listos.");
        // Verificación: la URL publicada responde con la versión nueva.
        agent = "deploy";
        const served = await serveProject(env, p.slug);
        if (!served || served.status !== 200 || !(await served.text()).includes("<h1>")) throw new Error("La URL publicada no respondió correctamente.");
        // Exportación a GitHub (rama «factory»), si hay conector configurado. No bloquea el despliegue.
        if (s.github_connector_id) {
          agent = "docs";
          try {
            const row = await one<any>(env.DB, "SELECT * FROM connectors WHERE id = ? AND owner_id = ? AND type = 'github' AND enabled = 1", s.github_connector_id, p.user_id);
            if (row) {
              const gh = (await instantiate(env, row)) as unknown as GitHubConnector;
              const spec = loads<any>(p.spec_json, {});
              const repo = await gh.commitToBranch("factory", `Kairo Factory · ${p.name}`, [
                { path: `factory/${p.slug}/index.html`, content: p.html },
                { path: `factory/${p.slug}/README.md`, content: `# ${p.name}\n\n${spec.tagline ?? ""}\n\n- Nicho: ${p.niche}\n- URL: ${url}\n- Stack: ${p.stack}\n- APIs: ${loads<string[]>(p.apis_json, []).join(", ")}\n\nGenerado y auditado por Kairo Factory.\n` },
              ]);
              await run(env.DB, "UPDATE fx_projects SET repo = ? WHERE id = ?", `${repo}/factory/${p.slug}`, id);
              await fxEmit(env, p.user_id, id, "deploying", "docs", "tool", "Código y README exportados a GitHub (rama factory).");
            }
          } catch (err) { await fxEmit(env, p.user_id, id, "deploying", "docs", "error", `Exportación a GitHub: ${(err as Error).message.slice(0, 200)}`); }
        }
        await advance(env, p, "live", { errors: null });
        await fxEmit(env, p.user_id, id, "live", "deploy", "result", `✓ LIVE: ${url}`);
        return;
      }
      case "maintenance": {
        agent = "monitor";
        const spec = loads<Spec>(p.spec_json, null as any);
        const checks = [...(await qaChecks(env, spec, p.html ?? "")), ...securityChecks(p.html ?? "")];
        await run(env.DB, "UPDATE fx_projects SET checks_json = ?, last_audit_at = ? WHERE id = ?", dumps({ ...loads(p.checks_json, {}), audit: checks, audit_at: nowIso() }), nowIso(), id);
        if (passed(checks)) {
          await advance(env, p, "live");
          await fxEmit(env, p.user_id, id, "maintenance", "monitor", "result", "Auditoría diaria correcta.");
        } else {
          await fxEmit(env, p.user_id, id, "maintenance", "monitor", "error", `Auditoría: ${failures(checks).join("; ").slice(0, 300)} → reparando.`);
          await backToBuild(env, p, "monitor", `Mantenimiento: ${failures(checks).join("; ")}`);
        }
        return;
      }
      default:
        await release("paused");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(env, p, agent, msg, err instanceof RouterError && (err.code === "free_quota" || isQuotaError(msg)));
  }
}

/** Una prueba falló: vuelve a construir con el informe (autocorrección), con límite de intentos. */
async function backToBuild(env: Env, p: any, agent: string, reason: string) {
  const attempts = (p.attempts ?? 0) + 1;
  if (attempts >= MAX_ATTEMPTS) return fail(env, { ...p, attempts: MAX_ATTEMPTS }, agent, reason, false);
  await run(env.DB, "UPDATE fx_projects SET stage = 'building', status = 'queued', attempts = ?, feedback = ?, errors = ?, lease_until = NULL, updated_at = ? WHERE id = ?", attempts, reason.slice(0, 1500), reason.slice(0, 500), nowIso(), p.id);
  await fxEmit(env, p.user_id, p.id, p.stage, agent, "retry", `Vuelve a desarrollo para corregir: ${reason.slice(0, 220)}`);
  await env.RUNS.send({ fxStep: p.id }, { delaySeconds: env.AI_MODE === "mock" ? 1 : 10 });
}

// ------------------------------------------------------------------ servir las webs (público)
const SITE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  // Sandbox: origen opaco → la web no puede leer cookies ni llamar a la API de Kairo con tu sesión.
  "Content-Security-Policy": "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self' https://api.dexscreener.com https://api.geckoterminal.com https://api.coingecko.com; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cache-Control": "public, max-age=60",
};

export async function serveProject(env: Env, slug: string): Promise<Response | null> {
  await ensureFactorySchema(env.DB);
  const p = await one<any>(env.DB, "SELECT html, version FROM fx_projects WHERE slug = ? AND html IS NOT NULL AND version > 0", slug);
  if (!p) return null;
  return new Response(p.html, { status: 200, headers: { ...SITE_HEADERS, ETag: `"${slug}-${p.version}"` } });
}

export async function siteIndex(env: Env): Promise<Response> {
  await ensureFactorySchema(env.DB);
  const rows = await all<any>(env.DB, "SELECT slug, name, niche, spec_json, live_at FROM fx_projects WHERE stage IN ('live','maintenance') AND version > 0 ORDER BY live_at DESC LIMIT 500");
  const e = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kairo Factory · Proyectos</title><meta name="description" content="Productos web creados, probados y auditados por Kairo Factory."><link rel="stylesheet" href="/fx-site.css?v=${assetVersion}"><style>:root{--bg:#0b1020;--surface:#121a33;--text:#f4f6fb;--muted:#a3adc8;--accent:#7aa2ff;--accent2:#34d399;--on-accent:#000;--radius:14px;--font-head:system-ui;--font-body:system-ui}</style></head><body><main class="fx-wrap" id="main"><h1 style="margin:48px 0 8px">Kairo Factory</h1><p class="fx-lead">${rows.length} productos en producción.</p><div class="fx-features">${rows.map((r) => { const s = loads<any>(r.spec_json, {}); return `<a class="fx-card" href="/s/${e(r.slug)}/"><h3>${e(r.name)}</h3><p>${e(String(s.tagline ?? ""))}</p><p class="fx-src">${e(r.niche)}</p></a>`; }).join("")}</div></main></body></html>`;
  return new Response(html, { headers: { ...SITE_HEADERS, "Content-Security-Policy": SITE_HEADERS["Content-Security-Policy"].replace(/connect-src [^;]+/, "connect-src 'none'") } });
}

export async function sitemap(env: Env): Promise<Response> {
  await ensureFactorySchema(env.DB);
  const rows = await all<any>(env.DB, "SELECT slug, updated_at FROM fx_projects WHERE stage IN ('live','maintenance') AND version > 0 ORDER BY id DESC LIMIT 5000");
  const o = origin(env);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.map((r) => `<url><loc>${o}/s/${r.slug}/</loc><lastmod>${String(r.updated_at).slice(0, 10)}</lastmod></url>`).join("")}</urlset>`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600" } });
}

// ------------------------------------------------------------------ cron: 24/7
export async function factoryTick(env: Env) {
  await ensureFactorySchema(env.DB);
  const now = nowIso();
  // Leases caducados → vuelven a la cola
  await run(env.DB, "UPDATE fx_projects SET status = 'queued', lease_until = NULL WHERE status = 'working' AND lease_until < ?", now);
  const users = await all<any>(env.DB, "SELECT * FROM fx_settings WHERE enabled = 1");
  for (const u of users) {
    const s = await fxSettings(env, u.user_id);
    const budgetOk = (await fxTokensToday(env, u.user_id)) < s.token_budget_day;
    // Misiones (órdenes permanentes): cada una rellena su cupo diario
    const missions = (await one<any>(env.DB, "SELECT COUNT(*) AS n FROM fx_missions WHERE user_id = ? AND active = 1", u.user_id))?.n ?? 0;
    if (missions && budgetOk) await missionTick(env, u.user_id).catch(() => undefined);
    // Ideas nuevas sueltas hasta el objetivo diario (solo si no hay misiones: las misiones mandan)
    if (!missions && s.auto_ideas && budgetOk) {
      const today = (await one<any>(env.DB, "SELECT COUNT(*) AS n FROM fx_projects WHERE user_id = ? AND created_at >= ?", u.user_id, todayIso()))?.n ?? 0;
      const open = (await one<any>(env.DB, "SELECT COUNT(*) AS n FROM fx_projects WHERE user_id = ? AND stage NOT IN ('live','maintenance') AND status NOT IN ('failed','rejected','paused')", u.user_id))?.n ?? 0;
      if (today < s.daily_target && open < s.max_parallel * 2) {
        const niches = s.niches.filter((n: any) => n.enabled && n.weight > 0);
        const total = niches.reduce((a: number, n: any) => a + n.weight, 0);
        let r = Math.random() * total, pick = niches[0];
        for (const n of niches) { r -= n.weight; if (r <= 0) { pick = n; break; } }
        if (pick) await ideate(env, u.user_id, pick.id, Math.min(3, s.daily_target - today)).catch((e) => fxEmit(env, u.user_id, null, "backlog", "research", "error", String(e.message ?? e).slice(0, 200)));
      }
    }
    // Despachar trabajo pendiente (máx. paralelo)
    const queued = await all<any>(env.DB, "SELECT id FROM fx_projects WHERE user_id = ? AND status IN ('queued'" + (budgetOk ? ",'waiting'" : "") + ") AND stage != 'live' ORDER BY priority DESC, id LIMIT ?", u.user_id, s.max_parallel);
    for (const q of queued) { if (budgetOk) await run(env.DB, "UPDATE fx_projects SET status = 'queued' WHERE id = ? AND status = 'waiting'", q.id); await env.RUNS.send({ fxStep: q.id }); }
    // Mantenimiento diario de lo publicado
    const stale = await all<any>(env.DB, "SELECT id FROM fx_projects WHERE user_id = ? AND stage = 'live' AND status != 'working' AND (last_audit_at IS NULL OR last_audit_at < ?) LIMIT 5", u.user_id, new Date(Date.now() - 24 * 3600_000).toISOString());
    for (const p of stale) { await run(env.DB, "UPDATE fx_projects SET stage = 'maintenance', status = 'queued' WHERE id = ?", p.id); await env.RUNS.send({ fxStep: p.id }); }
  }
}
