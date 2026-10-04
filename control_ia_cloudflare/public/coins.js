/* Coin Studio · apartado propio de meme coins.
 * Das una temática (cualquiera) y cuántas al día: la fábrica crea cada moneda con nombre, ticker,
 * mascota, historia, tokenomics, logo + ilustraciones (FLUX) y su web de lanzamiento, todos los días
 * hasta que la paras. Todo sale de /api/factory/coins (D1). */
"use strict";

const CS_STAGE = { backlog: "En cola", research: "Idea", building: "Diseñando", testing: "Probando", security: "Seguridad", deploying: "Publicando", live: "Publicada", maintenance: "Publicada" };
const CS_THEMES = ["Gatos samuráis", "Fútbol callejero", "Comida española", "Una IA rebelde", "Dinosaurios DJ", "Astronautas perezosos", "Ranas millonarias", "Vikingos del espacio"];

async function viewCoins(main) {
  let data = null, filter = "all", drawer = null;
  const root = h("div", { class: "cs-app" });
  main.replaceChildren(root);

  const theme = h("textarea", { class: "cs-input", rows: 2, maxlength: 280, placeholder: "Ej.: una criptomoneda de gatos samuráis que protegen la luna", "aria-label": "Temática de las monedas" });
  const per = h("input", { type: "range", min: 1, max: 50, value: 10, "aria-label": "Monedas al día" });
  const perOut = h("output", {}, "10");
  per.addEventListener("input", () => { perOut.textContent = per.value; });
  const go = async (ev) => {
    ev?.preventDefault();
    const text = theme.value.trim();
    if (text.length < 3) { theme.focus(); toast("Escribe una temática (puede ser cualquiera).", true); return; }
    try {
      const { mission: m } = await api("POST", "/api/factory/command", { text, kind: "memecoin", per_day: +per.value });
      toast(`Coin Studio trabajando: ${m.perDay} monedas al día sobre «${trunc(text, 40)}»`);
      theme.value = ""; load();
    } catch (e) { toast(e.message, true); }
  };

  const head = h("header", { class: "cs-head" });
  const composer = h("form", { class: "cs-composer", onsubmit: go },
    h("label", { class: "cs-label" }, "¿Sobre qué quieres tus criptomonedas?"),
    theme,
    h("div", { class: "cs-chips" }, CS_THEMES.map((t) => h("button", { type: "button", class: "cs-chip", onclick: () => { theme.value = t; theme.focus(); } }, t))),
    h("div", { class: "cs-row" },
      h("label", { class: "cs-per" }, h("span", {}, "Monedas al día"), per, perOut),
      h("button", { class: "cs-go", type: "submit" }, "Empezar a crear")),
    h("p", { class: "cs-hint" }, "Cada moneda sale con nombre, ticker, mascota, historia, tokenomics, roadmap, logo + 2 ilustraciones y su propia web de lanzamiento. Se repite sola cada día hasta que pulses Parar. Son conceptos: nada se lanza en una blockchain sin ti."));
  const missionsEl = h("section", { class: "cs-missions", "aria-label": "Producción en marcha" });
  const banner = h("div", { class: "cs-banner", role: "status", hidden: true });
  const tabs = h("div", { class: "cs-tabs", role: "tablist" });
  const grid = h("div", { class: "cs-grid" });
  const feed = h("ol", { class: "cs-feed" });
  root.append(head, banner, h("div", { class: "cs-top" }, composer, h("aside", { class: "cs-panel" }, h("h3", {}, "Taller en vivo"), feed)), missionsEl,
    h("section", { class: "cs-gal" }, h("div", { class: "cs-gal-h" }, h("h2", {}, "Tus monedas"), tabs), grid));

  const img = (c, name = "logo", cls = "") => (c.images || []).includes(name)
    ? h("img", { class: cls, src: `/s/${c.slug}/${name}`, alt: `${name === "logo" ? "Logo" : "Ilustración"} de ${c.name}`, loading: "lazy", decoding: "async" })
    : h("div", { class: cls + " cs-ph", "aria-hidden": "true" }, h("span", {}, (c.name || "?").slice(0, 1)));

  function render() {
    const d = data, t = d.totals;
    const failed = d.coins.filter((c) => c.status === "failed").length;
    banner.hidden = d.free_quota !== false && !failed;
    banner.replaceChildren(...(d.free_quota === false
      ? [h("b", {}, "Cupo gratis de IA agotado por hoy."), " Las monedas pendientes siguen solas cuando se renueve (02:00, hora de España). Para no depender del cupo, añade créditos a tu clave de Claude u OpenAI en Ajustes."]
      : failed ? [h("b", {}, `${failed} moneda(s) no se pudieron terminar.`), " ", h("button", { type: "button", class: "cs-btn", onclick: async () => {
          for (const c of d.coins.filter((x) => x.status === "failed")) await api("POST", `/api/factory/projects/${c.id}/retry`).catch(() => {});
          toast("Reintentando las monedas fallidas"); load(); } }, "Reintentar todas")] : []));
    head.replaceChildren(
      h("div", {}, h("p", { class: "cs-kicker" }, "Kairo · Coin Studio"), h("h1", {}, "Crea meme coins en piloto automático"),
        h("p", { class: "cs-sub" }, "Le dices una temática y el estudio se pasa el día creando monedas profesionales, cada una con su web lista para presentar.")),
      h("div", { class: "cs-kpis" }, [["Monedas", t.coins], ["Publicadas", t.live], ["Hoy", t.today], ["Creando ahora", t.working]].map(([k, v]) => h("div", { class: "cs-kpi" }, h("b", {}, String(v)), h("span", {}, k)))));
    missionsEl.replaceChildren(...(d.missions.length ? [h("h2", { class: "cs-h2" }, "Producción en marcha"), h("div", { class: "cs-mgrid" }, d.missions.map(missionCard))] : []));
    feed.replaceChildren(...(d.events.length ? d.events.slice(0, 18).map((e) => h("li", { class: `k-${e.kind}` }, h("time", {}, fmtTime(e.created_at)), h("b", {}, e.project), " ", trunc(e.message, 140)))
      : [h("li", { class: "cs-empty-li" }, "Aquí verás al director creativo, al editor y al ilustrador trabajando.")]));
    const live = d.coins.filter((c) => c.version > 0 && (c.stage === "live" || c.stage === "maintenance"));
    const wip = d.coins.filter((c) => !(c.version > 0 && (c.stage === "live" || c.stage === "maintenance")) && !["failed", "rejected"].includes(c.status));
    const tabsDef = [["all", `Todas · ${d.coins.length}`], ["live", `Publicadas · ${live.length}`], ["wip", `En proceso · ${wip.length}`]];
    tabs.replaceChildren(...tabsDef.map(([k, l]) => h("button", { type: "button", role: "tab", "aria-selected": String(filter === k), class: "cs-tab" + (filter === k ? " on" : ""), onclick: () => { filter = k; render(); } }, l)));
    const list = filter === "live" ? live : filter === "wip" ? wip : d.coins;
    grid.replaceChildren(...(list.length ? list.map(coinCard) : [h("div", { class: "cs-empty" }, h("b", {}, d.coins.length ? "Nada en esta vista." : "Todavía no hay monedas."), h("p", {}, "Escribe una temática arriba y pulsa «Empezar a crear». La primera tanda empieza al momento."))]));
  }

  function missionCard(m) {
    const pct = Math.min(100, Math.round((m.made_today / Math.max(1, m.per_day)) * 100));
    return h("article", { class: "cs-mission" + (m.active ? " on" : "") },
      h("div", { class: "cs-ring", style: `--p:${pct}`, role: "img", "aria-label": `${m.made_today} de ${m.per_day} hoy` }, h("b", {}, `${m.made_today}/${m.per_day}`), h("span", {}, "hoy")),
      h("div", { class: "cs-mbody" },
        h("p", { class: "cs-mstate" }, m.active ? (m.working ? "● Creando ahora" : "● Activa todos los días") : "○ Parada"),
        h("h3", {}, trunc(m.prompt, 70)),
        h("p", { class: "cs-msmall" }, `${m.live_total} publicadas en total`),
        h("div", { class: "cs-macts" },
          h("button", { type: "button", class: "cs-btn" + (m.active ? " ghost" : ""), onclick: async () => { await api("PATCH", `/api/factory/missions/${m.id}`, { active: !m.active }); toast(m.active ? "Producción parada" : "Producción reanudada"); load(); } }, m.active ? "Parar" : "Reanudar"),
          h("button", { type: "button", class: "cs-btn ghost", onclick: async () => {
            if (!(await confirmDialog({ title: "Borrar producción", body: "Se borra la orden. Las monedas ya creadas se quedan.", confirmLabel: "Borrar", danger: true }))) return;
            await api("DELETE", `/api/factory/missions/${m.id}`); load(); } }, "Borrar"))));
  }

  function coinCard(c) {
    const isLive = c.version > 0 && (c.stage === "live" || c.stage === "maintenance");
    const bad = ["failed", "rejected"].includes(c.status);
    return h("article", { class: "cs-coin" + (isLive ? "" : " wip") + (bad ? " bad" : ""), style: `--c:${c.accent || "#8b5cf6"};--b:${c.bg || "#0b0b12"}` },
      h("button", { type: "button", class: "cs-coin-art", onclick: () => openCoin(c.id), "aria-label": `Detalles de ${c.name}` }, img(c, "logo", "cs-coin-img"),
        h("span", { class: "cs-badge" + (isLive ? " ok" : bad ? " ko" : "") }, bad ? (c.status === "failed" ? "Fallida" : "Descartada") : isLive ? "Publicada" : `${CS_STAGE[c.stage] || c.stage}…`)),
      h("div", { class: "cs-coin-b" },
        h("div", { class: "cs-coin-t" }, h("h3", {}, c.name), c.ticker ? h("span", { class: "cs-tk" }, `$${c.ticker}`) : null),
        h("p", {}, trunc(c.tagline || c.idea, 96)),
        h("div", { class: "cs-tags" }, c.quality ? h("span", {}, `★ ${Number(c.quality).toFixed(0)}/10`) : null, c.style ? h("span", {}, c.style) : null, c.chain ? h("span", {}, c.chain) : null),
        h("div", { class: "cs-coin-a" },
          isLive ? h("a", { class: "cs-btn", href: c.url, target: "_blank", rel: "noopener" }, "Ver web ↗") : null,
          c.status === "failed" ? h("button", { type: "button", class: "cs-btn", onclick: async () => { await api("POST", `/api/factory/projects/${c.id}/retry`); toast("Reintentando"); load(); } }, "Reintentar") : null,
          h("button", { type: "button", class: "cs-btn ghost", onclick: () => openCoin(c.id) }, "Detalles"))));
  }

  async function openCoin(id) {
    const p = await api("GET", `/api/factory/projects/${id}`);
    const c = data.coins.find((x) => x.id === id) || { images: [] };
    const coin = p.spec.coin || {};
    drawer?.remove();
    const act = (a, label, cls = "") => h("button", { class: "cs-btn " + cls, type: "button", onclick: async () => {
      if (a === "delete" && !(await confirmDialog({ title: "Borrar moneda", body: `Se borra «${p.name}» y su web.`, confirmLabel: "Borrar", danger: true }))) return;
      try { await api("POST", `/api/factory/projects/${id}/${a}`); toast(a === "rebuild" ? "Rehaciendo con un concepto mejorado" : "Hecho"); drawer?.remove(); drawer = null; load(); } catch (e) { toast(e.message, true); } } }, label);
    drawer = h("aside", { class: "cs-drawer", role: "dialog", "aria-label": p.name },
      h("header", {}, h("div", {}, h("p", { class: "cs-kicker" }, coin.ticker ? `$${coin.ticker} · ${coin.chain || ""}` : "Meme coin"), h("h2", {}, p.name)),
        h("button", { class: "cs-x", type: "button", "aria-label": "Cerrar", onclick: () => { drawer.remove(); drawer = null; } }, "✕")),
      h("div", { class: "cs-shots" }, ["logo", "art", "meme"].filter((n) => (c.images || []).includes(n)).map((n) => h("a", { href: `/s/${p.slug}/${n}`, target: "_blank", rel: "noopener" }, img({ ...c, slug: p.slug }, n, "cs-shot")))),
      h("p", { class: "cs-lead" }, p.spec.tagline || p.idea),
      coin.description ? h("p", {}, coin.description) : null,
      h("dl", { class: "cs-dl" }, ...[["Temática", coin.theme || p.research.theme], ["Mascota", coin.mascot], ["Estilo", coin.style], ["Calidad (editor)", p.research.quality ? `${p.research.quality}/10` : null], ["Suministro", coin.supply], ["Impuestos", coin.taxes], ["Estado", CS_STAGE[p.stage] || p.stage]].filter(([, v]) => v).map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, String(v))))),
      coin.lore ? h("details", { class: "cs-det", open: true }, h("summary", {}, "Historia"), h("p", {}, coin.lore)) : null,
      p.url && p.version ? h("div", { class: "cs-prev" }, h("iframe", { src: p.url, title: `Web de ${p.name}`, sandbox: "allow-scripts allow-popups", loading: "lazy" }), h("a", { class: "cs-btn", href: p.url, target: "_blank", rel: "noopener" }, "Abrir la web ↗")) : null,
      p.errors ? h("p", { class: "cs-err" }, p.errors) : null,
      h("div", { class: "cs-macts" }, act("rebuild", "Rehacer mejor"), p.status === "failed" ? act("retry", "Reintentar") : null, act("delete", "Borrar", "ghost")),
      h("details", { class: "cs-det" }, h("summary", {}, "Cómo se hizo"), h("ol", { class: "cs-feed" }, p.events.map((e) => h("li", { class: `k-${e.kind}` }, h("time", {}, fmtTime(e.created_at)), h("b", {}, e.agent), " ", e.message)))));
    root.append(drawer);
  }

  async function load() {
    data = await api("GET", "/api/factory/coins");
    if (root.contains(document.activeElement) && document.activeElement.matches("input, textarea")) { return; }
    render();
  }
  await load();
  every(4000, load);
}
