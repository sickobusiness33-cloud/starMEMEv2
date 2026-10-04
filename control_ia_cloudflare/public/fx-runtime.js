/* Kairo Factory runtime: el ÚNICO JavaScript de las webs de la fábrica (auditado, sin eval, sin HTML inyectado).
 * Las webs se sirven con CSP sandbox (origen opaco): no pueden leer cookies ni tu sesión de Kairo.
 * Widgets: datos reales (DexScreener / CoinGecko vía /fx/data), IA (/fx/ai/<slug>) y calculadoras con fórmulas publicadas. */
(() => {
  "use strict";
  const cfgEl = document.getElementById("fx-config");
  if (!cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent || "{}");
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  };
  // localStorage lanza en origen opaco: memoria como respaldo.
  const mem = {};
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { mem[k] = v; } } };

  // ---- formato
  const usd = (n) => n == null ? "—" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(n < 1 ? 2 : 0)}`;
  const price = (n) => n == null ? "—" : n >= 1 ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}` : `$${n.toPrecision(3)}`;
  const pct = (n) => n == null ? el("span", { class: "fx-muted", text: "—" }) : el("span", { class: n >= 0 ? "fx-up" : "fx-down", text: `${n >= 0 ? "▲" : "▼"} ${Math.abs(n).toFixed(1)}%` });
  const age = (ms) => { if (!ms) return "—"; const h = (Date.now() - ms) / 3600e3; return h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`; };
  const linkOut = (href, text) => el("a", { href, target: "_blank", rel: "noopener noreferrer", text });

  // ---- datos directos desde el navegador del visitante (las APIs permiten CORS; así no hay límite por IP de servidor)
  const num = (v) => { const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN; return Number.isFinite(n) ? n : null; };
  async function getJson(url) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
    try { const r = await fetch(url, { headers: { Accept: "application/json" }, signal: ctl.signal }); if (!r.ok) throw new Error(String(r.status)); return await r.json(); }
    finally { clearTimeout(t); }
  }
  const normPair = (p) => ({
    name: String(p.baseToken?.name ?? "").slice(0, 80), symbol: String(p.baseToken?.symbol ?? "").slice(0, 24), chain: String(p.chainId ?? ""),
    address: String(p.baseToken?.address ?? ""), pair: String(p.pairAddress ?? ""), dex: String(p.dexId ?? ""), priceUsd: num(p.priceUsd),
    change: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
    liquidityUsd: num(p.liquidity?.usd), volume24h: num(p.volume?.h24), buys24h: num(p.txns?.h24?.buys), sells24h: num(p.txns?.h24?.sells),
    marketCap: num(p.marketCap), fdv: num(p.fdv), createdAt: num(p.pairCreatedAt),
    url: typeof p.url === "string" && p.url.startsWith("https://dexscreener.com/") ? p.url : `https://dexscreener.com/${p.chainId}/${p.pairAddress}`,
    icon: typeof p.info?.imageUrl === "string" && p.info.imageUrl.startsWith("https://") ? p.info.imageUrl : null,
  });
  const best = (rows) => { const m = new Map(); for (const r of rows) { const k = `${r.chain}:${r.address}`; if (!m.has(k) || (r.liquidityUsd ?? 0) > (m.get(k).liquidityUsd ?? 0)) m.set(k, r); } return [...m.values()]; };
  const DEX = "https://api.dexscreener.com", GT = "https://api.geckoterminal.com/api/v2", CG = "https://api.coingecko.com/api/v3";
  async function enrich(list) {
    const by = new Map();
    for (const t of list || []) if (t.chainId && t.tokenAddress) { const a = by.get(t.chainId) || []; if (!a.includes(t.tokenAddress) && a.length < 30) a.push(t.tokenAddress); by.set(t.chainId, a); }
    const out = [];
    await Promise.all([...by].slice(0, 4).map(async ([chain, addrs]) => { const d = await getJson(`${DEX}/tokens/v1/${encodeURIComponent(chain)}/${addrs.map(encodeURIComponent).join(",")}`).catch(() => []); out.push(...best((Array.isArray(d) ? d : []).map(normPair))); }));
    return out;
  }
  function gtRows(d) {
    const toks = new Map((d?.included || []).filter((x) => x.type === "token").map((x) => [x.id, x.attributes]));
    return best((d?.data || []).map((p) => {
      const a = p.attributes || {}, rel = p.relationships || {}, t = toks.get(rel.base_token?.data?.id) || {}, pc = a.price_change_percentage || {}, tx = a.transactions?.h24 || {};
      const chain = String(rel.network?.data?.id ?? String(p.id || "").split("_")[0]);
      return { name: String(t.name ?? a.name ?? ""), symbol: String(t.symbol ?? String(a.name ?? "").split(" / ")[0]), chain, address: String(t.address ?? ""), pair: String(a.address ?? ""), dex: String(rel.dex?.data?.id ?? ""),
        priceUsd: num(a.base_token_price_usd), change: { m5: num(pc.m5), h1: num(pc.h1), h6: num(pc.h6), h24: num(pc.h24) }, liquidityUsd: num(a.reserve_in_usd), volume24h: num(a.volume_usd?.h24),
        buys24h: num(tx.buys), sells24h: num(tx.sells), marketCap: num(a.market_cap_usd), fdv: num(a.fdv_usd), createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
        url: `https://www.geckoterminal.com/${encodeURIComponent(chain)}/pools/${encodeURIComponent(String(a.address ?? ""))}`, icon: typeof t.image_url === "string" && t.image_url.startsWith("https://") ? t.image_url : null };
    }));
  }
  const gt = (path) => getJson(`${GT}${path}${path.includes("?") ? "&" : "?"}include=base_token,dex`).then(gtRows);
  async function chain(steps) { for (const [source, fn] of steps) { try { const data = await fn(); if (Array.isArray(data) ? data.length : data) return { data, source, at: new Date().toISOString() }; } catch {} } throw new Error("Las fuentes de datos no responden ahora mismo. Reintenta en unos segundos."); }
  const server = (path, params) => async () => { const u = new URL(path, location.href); for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v); const r = await fetch(u); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.data; };
  const CLIENT = {
    "/fx/data/crypto/trending": () => chain([["DexScreener", async () => (await enrich(await getJson(`${DEX}/token-boosts/top/v1`))).sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, 30)], ["GeckoTerminal", () => gt("/networks/trending_pools?page=1")], ["Kairo (proxy)", server("/fx/data/crypto/trending")]]),
    "/fx/data/crypto/new": () => chain([["DexScreener", async () => (await enrich(await getJson(`${DEX}/token-profiles/latest/v1`))).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 30)], ["GeckoTerminal", () => gt("/networks/new_pools?page=1")], ["Kairo (proxy)", server("/fx/data/crypto/new")]]),
    "/fx/data/crypto/search": (p) => chain([["DexScreener", async () => best(((await getJson(`${DEX}/latest/dex/search?q=${encodeURIComponent(p.q)}`)).pairs || []).map(normPair)).sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, 20)], ["GeckoTerminal", () => gt(`/search/pools?query=${encodeURIComponent(p.q)}`)], ["Kairo (proxy)", server("/fx/data/crypto/search", p)]]),
    "/fx/data/crypto/token": (p) => chain([["DexScreener", async () => { const d = await getJson(`${DEX}/tokens/v1/${encodeURIComponent(p.chain)}/${encodeURIComponent(p.address)}`); return best((Array.isArray(d) ? d : []).map(normPair))[0] || null; }], ["GeckoTerminal", async () => (await gt(`/networks/${encodeURIComponent(p.chain)}/tokens/${encodeURIComponent(p.address)}/pools?page=1`))[0] || null]]),
    "/fx/data/crypto/market": () => chain([["CoinGecko", async () => { const d = await getJson(`${CG}/search/trending`); return { coins: (d.coins || []).slice(0, 15).map((c) => ({ name: c.item?.name, symbol: c.item?.symbol, rank: num(c.item?.market_cap_rank), priceUsd: num(c.item?.data?.price), change24h: num(c.item?.data?.price_change_percentage_24h?.usd), image: typeof c.item?.small === "string" && c.item.small.startsWith("https://") ? c.item.small : null, url: `https://www.coingecko.com/en/coins/${encodeURIComponent(c.item?.id ?? "")}` })) }; }], ["Kairo (proxy)", server("/fx/data/crypto/market")]]),
  };

  async function getData(path, params) {
    if (CLIENT[path]) return CLIENT[path](params || {});
    const u = new URL(path, location.href);
    if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    let r;
    try { r = await fetch(u, { headers: { Accept: "application/json" } }); } catch { throw new Error("No se pudo conectar con la fuente de datos. Reintenta en unos segundos."); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
    return j;
  }
  const fail = (body, msg, retry) => body.replaceChildren(el("div", { class: "fx-empty" }, el("p", { text: msg }), retry ? el("button", { class: "fx-btn small ghost", type: "button", onclick: retry, text: "Reintentar" }) : null));
  const stamp = (j) => el("p", { class: "fx-src" }, `Fuente: ${j.source || "API pública"} · ${new Date(j.at || Date.now()).toLocaleTimeString()}`);

  // ---- heurística transparente (no es una recomendación)
  function riskOf(r) {
    const flags = [];
    if (r.liquidityUsd != null && r.liquidityUsd < 10000) flags.push("liquidez baja");
    if ((r.liquidityUsd ?? 0) > 100000 && (r.volume24h ?? 0) < 1000) flags.push("volumen casi nulo: liquidez dudosa");
    if (r.marketCap && r.liquidityUsd && r.liquidityUsd / r.marketCap < 0.03) flags.push("liquidez/mcap < 3%");
    if (r.createdAt && Date.now() - r.createdAt < 24 * 3600e3) flags.push("par < 24 h");
    if (r.buys24h != null && r.sells24h != null && r.sells24h > r.buys24h * 2) flags.push("ventas ≫ compras");
    return flags;
  }

  function tokenTable(body, rows, { sortable = true } = {}) {
    let key = "volume24h", dir = -1;
    const cols = [["Token", null], ["Precio", "priceUsd"], ["24h", "h24"], ["Liquidez", "liquidityUsd"], ["Vol. 24h", "volume24h"], ["Mcap", "marketCap"], ["Edad", "createdAt"], ["Txns 24h", null]];
    const val = (r, k) => k === "h24" ? r.change.h24 : r[k];
    const wrap = el("div", { class: "fx-table-wrap" });
    const render = () => {
      const sorted = [...rows].sort((a, b) => ((val(a, key) ?? -Infinity) - (val(b, key) ?? -Infinity)) * dir);
      wrap.replaceChildren(el("table", { class: "fx-table" },
        el("thead", {}, el("tr", {}, cols.map(([label, k]) => el("th", { scope: "col", "aria-sort": k === key ? (dir < 0 ? "descending" : "ascending") : null },
          k && sortable ? el("button", { type: "button", onclick: () => { dir = key === k ? -dir : -1; key = k; render(); }, text: label + (k === key ? (dir < 0 ? " ↓" : " ↑") : "") }) : label)))),
        el("tbody", {}, sorted.map((r) => {
          const flags = riskOf(r);
          return el("tr", {},
            el("td", {}, el("div", { class: "fx-tok" }, r.icon ? el("img", { src: r.icon, alt: "", width: 22, height: 22, loading: "lazy" }) : el("span", { class: "fx-tok-i", text: (r.symbol || "?").slice(0, 1) }),
              el("div", {}, linkOut(r.url, r.symbol || r.name), el("small", { text: `${r.chain} · ${r.dex}` }), flags.length ? el("small", { class: "fx-flag", title: "Heurística automática, no es una recomendación", text: `⚠ ${flags.join(" · ")}` }) : null))),
            el("td", { class: "num", text: price(r.priceUsd) }), el("td", { class: "num" }, pct(r.change.h24)),
            el("td", { class: "num", text: usd(r.liquidityUsd) }), el("td", { class: "num", text: usd(r.volume24h) }), el("td", { class: "num", text: usd(r.marketCap ?? r.fdv) }),
            el("td", { class: "num", text: age(r.createdAt) }), el("td", { class: "num", text: r.buys24h == null ? "—" : `${r.buys24h} / ${r.sells24h}` }));
        }))));
    };
    render();
    return wrap;
  }

  // ---- widgets
  const W = {};
  W["crypto-trending"] = async (body) => {
    const load = async () => {
      try {
        const j = await getData("/fx/data/crypto/trending");
        if (!j.data?.length) return fail(body, "La fuente no devolvió tokens ahora mismo.", load);
        body.replaceChildren(tokenTable(body, j.data), stamp(j));
        stats(j.data);
      } catch (e) { fail(body, e.message, load); }
    };
    await load(); setInterval(() => { if (!document.hidden) load(); }, 60000);
  };
  W["crypto-new"] = async (body) => {
    const load = async () => {
      try {
        const j = await getData("/fx/data/crypto/new");
        if (!j.data?.length) return fail(body, "Sin tokens nuevos en este momento.", load);
        body.replaceChildren(tokenTable(body, j.data), stamp(j));
        stats(j.data);
      } catch (e) { fail(body, e.message, load); }
    };
    await load(); setInterval(() => { if (!document.hidden) load(); }, 60000);
  };
  W["crypto-market"] = async (body) => {
    try {
      const j = await getData("/fx/data/crypto/market");
      const coins = j.data?.coins || [];
      if (!coins.length) return fail(body, "Sin datos de mercado ahora mismo.");
      body.replaceChildren(el("ol", { class: "fx-coins" }, coins.map((c) => el("li", {},
        c.image ? el("img", { src: c.image, alt: "", width: 24, height: 24, loading: "lazy" }) : null,
        el("span", { class: "grow" }, linkOut(c.url, c.name), el("small", { text: ` ${c.symbol}${c.rank ? ` · #${c.rank}` : ""}` })),
        el("span", { class: "num", text: price(c.priceUsd) }), pct(c.change24h)))), stamp(j));
    } catch (e) { fail(body, e.message); }
  };
  function lookup(body, { watch = false } = {}) {
    const input = el("input", { type: "search", placeholder: "Símbolo, nombre o dirección del token", "aria-label": "Buscar token", autocomplete: "off" });
    const out = el("div", { "aria-live": "polite" });
    const list = () => JSON.parse(store.get("fx-watch-" + cfg.slug) || "[]");
    const renderWatch = async () => {
      const items = list();
      if (!items.length) return out.replaceChildren(el("p", { class: "fx-muted", text: "Tu lista está vacía: busca un token y pulsa «Seguir»." }));
      const rows = [];
      for (const it of items.slice(0, 12)) { try { const j = await getData("/fx/data/crypto/token", { chain: it.chain, address: it.address }); if (j.data) rows.push(j.data); } catch {} }
      out.replaceChildren(rows.length ? tokenTable(out, rows) : el("p", { class: "fx-muted", text: "No se pudieron cargar los datos." }));
    };
    const search = async (ev) => {
      ev?.preventDefault();
      const q = input.value.trim();
      if (q.length < 2) return;
      out.replaceChildren(el("div", { class: "fx-skel" }));
      try {
        const j = await getData("/fx/data/crypto/search", { q });
        if (!j.data?.length) return out.replaceChildren(el("p", { class: "fx-muted", text: "Sin resultados." }));
        out.replaceChildren(el("div", { class: "fx-cards" }, j.data.slice(0, 6).map((r) => {
          const flags = riskOf(r);
          return el("article", { class: "fx-tcard" },
            el("header", {}, el("b", {}, linkOut(r.url, `${r.symbol} · ${r.name}`)), el("small", { text: `${r.chain} · ${r.dex}` })),
            el("dl", {}, ...[["Precio", price(r.priceUsd)], ["Liquidez", usd(r.liquidityUsd)], ["Vol. 24h", usd(r.volume24h)], ["Mcap", usd(r.marketCap ?? r.fdv)], ["Edad", age(r.createdAt)], ["Compras/ventas", r.buys24h == null ? "—" : `${r.buys24h} / ${r.sells24h}`]].flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { class: "num", text: v })])),
            el("p", {}, "24h: ", pct(r.change.h24), " · 1h: ", pct(r.change.h1)),
            flags.length ? el("p", { class: "fx-flag", text: `⚠ ${flags.join(" · ")} (heurística, no es consejo)` }) : el("p", { class: "fx-muted small", text: "Sin señales de alerta en la heurística básica." }),
            watch ? el("button", { class: "fx-btn small", type: "button", onclick: () => { const l = list().filter((x) => x.address !== r.address); l.unshift({ chain: r.chain, address: r.address }); store.set("fx-watch-" + cfg.slug, JSON.stringify(l.slice(0, 20))); renderWatch(); }, text: "Seguir" }) : null);
        })), stamp(j));
      } catch (e) { out.replaceChildren(el("p", { class: "fx-muted", text: e.message })); }
    };
    body.replaceChildren(el("form", { class: "fx-row", onsubmit: search }, input, el("button", { class: "fx-btn", type: "submit", text: "Analizar" })), out);
    if (watch) renderWatch();
  }
  W["crypto-lookup"] = (body) => lookup(body);
  W["crypto-watchlist"] = (body) => lookup(body, { watch: true });

  W["ai-tool"] = (body) => {
    const ai = cfg.ai || {};
    const ta = el("textarea", { rows: 4, maxlength: 1500, placeholder: ai.placeholder || "Escribe aquí…", "aria-label": ai.placeholder || "Entrada" });
    const out = el("div", { class: "fx-ai-out", "aria-live": "polite" });
    const btn = el("button", { class: "fx-btn", type: "submit", text: ai.label || "Generar" });
    const send = async (ev) => {
      ev.preventDefault();
      const input = ta.value.trim();
      if (input.length < 2) return ta.focus();
      btn.disabled = true; btn.textContent = "Pensando…"; out.replaceChildren(el("div", { class: "fx-skel" }));
      try {
        const r = await fetch(`/fx/ai/${encodeURIComponent(cfg.slug)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) }).catch(() => { throw new Error("No se pudo conectar. Reintenta en unos segundos."); });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
        const copy = el("button", { class: "fx-btn small ghost", type: "button", text: "Copiar", onclick: () => navigator.clipboard?.writeText(j.text).then(() => { copy.textContent = "Copiado"; }) });
        out.replaceChildren(el("div", { class: "fx-ai-text", text: j.text }), el("div", { class: "fx-row end" }, el("small", { class: "fx-muted", text: j.model ? `Modelo: ${j.model}` : "" }), copy));
      } catch (e) { out.replaceChildren(el("p", { class: "fx-muted", text: e.message })); }
      btn.disabled = false; btn.textContent = ai.label || "Generar";
    };
    body.replaceChildren(el("form", { class: "fx-ai", onsubmit: send }, ta,
      ai.examples?.length ? el("div", { class: "fx-chips" }, ai.examples.map((e) => el("button", { type: "button", class: "fx-chip", text: e, onclick: () => { ta.value = e; ta.focus(); } }))) : null,
      el("div", { class: "fx-row end" }, btn)), out);
  };

  // ---- calculadoras (fórmulas publicadas; todo en el navegador)
  function calc(body, fields, compute, note) {
    const form = el("form", { class: "fx-calc" });
    const out = el("div", { class: "fx-calc-out", "aria-live": "polite" });
    const inputs = {};
    for (const f of fields) {
      const id = `${cfg.slug}-${f.id}`;
      const input = f.options ? el("select", { id }, f.options.map(([v, l]) => el("option", { value: v, text: l, selected: v === f.value })))
        : el("input", { id, type: "number", inputmode: "decimal", min: f.min, max: f.max, step: f.step || "any", value: f.value, required: true });
      inputs[f.id] = input;
      form.append(el("label", { for: id }, el("span", { text: f.label }), input));
    }
    const run = (ev) => { ev?.preventDefault(); const v = {}; for (const [k, i] of Object.entries(inputs)) v[k] = i.tagName === "SELECT" ? i.value : Number(i.value); out.replaceChildren(...compute(v)); };
    form.append(el("button", { class: "fx-btn", type: "submit", text: "Calcular" }));
    form.addEventListener("submit", run);
    body.replaceChildren(form, out, note ? el("p", { class: "fx-src", text: note }) : null);
    run();
  }
  const kv = (label, value, strong) => el("div", { class: "fx-kv" + (strong ? " strong" : "") }, el("span", { text: label }), el("b", { class: "num", text: value }));
  W["calc-tdee"] = (b) => calc(b, [
    { id: "sex", label: "Sexo", options: [["m", "Hombre"], ["f", "Mujer"]], value: "m" }, { id: "age", label: "Edad", value: 30, min: 14, max: 99 },
    { id: "w", label: "Peso (kg)", value: 75, min: 30, max: 300 }, { id: "h", label: "Altura (cm)", value: 175, min: 120, max: 230 },
    { id: "act", label: "Actividad", options: [["1.2", "Sedentaria"], ["1.375", "Ligera"], ["1.55", "Moderada"], ["1.725", "Alta"], ["1.9", "Muy alta"]], value: "1.55" },
  ], (v) => { const bmr = 10 * v.w + 6.25 * v.h - 5 * v.age + (v.sex === "m" ? 5 : -161); const t = bmr * Number(v.act);
    return [kv("Metabolismo basal", `${Math.round(bmr)} kcal`), kv("Gasto diario (TDEE)", `${Math.round(t)} kcal`, true), kv("Para perder ~0,5 kg/sem", `${Math.round(t - 500)} kcal`), kv("Para ganar masa", `${Math.round(t + 300)} kcal`)]; },
    "Fórmula Mifflin-St Jeor (1990). Estimación orientativa, no sustituye a un profesional.");
  W["calc-macros"] = (b) => calc(b, [
    { id: "kcal", label: "Calorías diarias", value: 2400, min: 1000, max: 6000 }, { id: "w", label: "Peso (kg)", value: 75, min: 30, max: 300 },
    { id: "goal", label: "Objetivo", options: [["cut", "Definición"], ["keep", "Mantenimiento"], ["bulk", "Volumen"]], value: "keep" },
  ], (v) => { const pg = v.goal === "cut" ? 2.2 : v.goal === "bulk" ? 1.8 : 1.6; const p = pg * v.w, f = (v.kcal * 0.27) / 9, c = Math.max(0, (v.kcal - p * 4 - f * 9) / 4);
    return [kv("Proteína", `${Math.round(p)} g`, true), kv("Grasas", `${Math.round(f)} g`), kv("Carbohidratos", `${Math.round(c)} g`)]; },
    "Proteína 1,6–2,2 g/kg (ISSN 2017), grasas ~27% de las kcal, resto carbohidratos.");
  W["calc-1rm"] = (b) => calc(b, [{ id: "kg", label: "Peso levantado (kg)", value: 80, min: 1, max: 500 }, { id: "reps", label: "Repeticiones", value: 5, min: 1, max: 15 }],
    (v) => { const e = v.kg * (1 + v.reps / 30), br = v.kg * 36 / (37 - v.reps); return [kv("1RM (Epley)", `${e.toFixed(1)} kg`, true), kv("1RM (Brzycki)", `${br.toFixed(1)} kg`), ...[90, 80, 70].map((p) => kv(`${p}% del 1RM`, `${(e * p / 100).toFixed(1)} kg`))]; },
    "Fórmulas de Epley (1985) y Brzycki (1993). Más fiables con 2–10 repeticiones.");
  W["calc-pace"] = (b) => calc(b, [{ id: "km", label: "Distancia (km)", value: 10, min: 0.1, max: 300, step: "0.1" }, { id: "min", label: "Tiempo (min)", value: 50, min: 1, max: 2000 }],
    (v) => { const p = v.min / v.km, s = (x) => `${Math.floor(x)}:${String(Math.round((x % 1) * 60)).padStart(2, "0")}`; return [kv("Ritmo", `${s(p)} min/km`, true), kv("Velocidad", `${(v.km / (v.min / 60)).toFixed(2)} km/h`), kv("Media maratón a este ritmo", `${s(p * 21.0975 / 60)} h`), kv("Maratón a este ritmo", `${s(p * 42.195 / 60)} h`)]; });
  W["calc-hrzones"] = (b) => calc(b, [{ id: "age", label: "Edad", value: 30, min: 10, max: 99 }, { id: "rest", label: "Pulso en reposo (lpm)", value: 60, min: 30, max: 120 }],
    (v) => { const max = 208 - 0.7 * v.age, r = max - v.rest; return [kv("FC máxima (Tanaka)", `${Math.round(max)} lpm`, true), ...[["Z1 recuperación", 0.5, 0.6], ["Z2 aeróbica", 0.6, 0.7], ["Z3 tempo", 0.7, 0.8], ["Z4 umbral", 0.8, 0.9], ["Z5 VO2max", 0.9, 1]].map(([n, a, z]) => kv(n, `${Math.round(v.rest + r * a)}–${Math.round(v.rest + r * z)} lpm`))]; },
    "FC máx. de Tanaka (2001) y zonas por reserva cardiaca (Karvonen).");

  // ---- cifras del hero (solo con datos reales cargados)
  let statsDone = false;
  function stats(rows) {
    const box = $("[data-stats]");
    if (!box || statsDone || !rows?.length) return;
    statsDone = true;
    const vol = rows.reduce((a, r) => a + (r.volume24h || 0), 0), liq = rows.reduce((a, r) => a + (r.liquidityUsd || 0), 0);
    box.replaceChildren(...[["Tokens analizados", String(rows.length)], ["Volumen 24h", usd(vol)], ["Liquidez", usd(liq)]].map(([k, v]) => el("div", {}, el("b", { class: "num", text: v }), el("span", { text: k }))));
  }

  // ---- arranque
  for (const sec of document.querySelectorAll("[data-widget]")) {
    const body = $(".fx-widget-b", sec), fn = W[sec.dataset.widget];
    if (fn) Promise.resolve(fn(body)).catch((e) => fail(body, e.message));
  }
  // Tema claro/oscuro (respeta la preferencia del sistema la primera vez)
  const root = document.documentElement, key = "fx-theme-" + cfg.slug;
  const saved = store.get(key);
  if (saved) root.dataset.theme = saved;
  $(".fx-theme")?.addEventListener("click", () => { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; store.set(key, root.dataset.theme); });
  // Aparición al hacer scroll (solo transform/opacity; respeta reduced-motion)
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px", threshold: 0.01 });
    // Solo lo que está por debajo de la pantalla al cargar (lo visible nunca parpadea).
    document.querySelectorAll(".fx-card, .fx-steps li, .fx-faq").forEach((n) => { if (n.getBoundingClientRect().top > innerHeight) { n.classList.add("fx-reveal"); io.observe(n); } });
  }
})();
