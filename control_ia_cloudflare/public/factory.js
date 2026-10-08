/* Kairo Factory · panel de la fábrica autónoma de proyectos.
 * Pantalla de color sólido con la red de agentes trabajando sola. Todo lo que se ve sale de
 * /api/factory (D1): un agente brilla solo si hay un proyecto real en su etapa ahora mismo. */
"use strict";

const FX_THEMES = { cobalt: "#1638e8", emerald: "#0b8a5f", crimson: "#c81e3a", graphite: "#1b1e24", violet: "#5b21b6" };
const FX_STAGE_LABEL = { backlog: "Backlog", research: "Research", building: "Building", testing: "Testing", security: "Security", deploying: "Deploying", live: "Live", maintenance: "Mantenimiento" };
const FX_STATUS = { ok: "en producción", queued: "en cola", working: "trabajando", waiting: "esperando cupo", failed: "fallido", rejected: "descartado", paused: "en pausa" };
const FX_NICHE = { crypto: "Crypto / Meme coins", ai: "Inteligencia Artificial", nutrition: "Nutrición", sport: "Deporte", other: "Otros" };
const FX_CLUSTERS = [["research", ["research", "product"]], ["building", ["architect", "uiux", "frontend", "backend", "database", "marketing"]], ["testing", ["testing", "qa"]], ["security", ["security"]], ["deploying", ["seo", "devops", "deploy", "docs"]], ["maintenance", ["monitor"]]];

async function viewFactory(main) {
  let data = null, sel = null, drawer = null;
  const root = h("div", { class: "fx-app" });
  main.replaceChildren(root);

  const cmd = h("input", { type: "text", class: "fx-cmd", placeholder: "Créame criptomonedas · Hazme webs de deportes · 5 webs de IA al día", "aria-label": "Orden para la fábrica", maxlength: 300 });
  const send = async (ev) => {
    ev?.preventDefault();
    const text = cmd.value.trim();
    if (!text) { cmd.focus(); return; }
    try {
      const { mission: m } = await api("POST", "/api/factory/command", { text });
      toast(`Misión creada: ${m.title} · ${m.perDay} al día, todos los días, hasta que la pares`);
      cmd.value = ""; load();
    } catch (e) { toast(e.message, true); }
  };
  const missionsEl = h("section", { class: "fx-missions", "aria-label": "Misiones activas" });
  const gallery = h("section", { class: "fx-panel" });
  const top = h("header", { class: "fx-top" });
  const kpis = h("div", { class: "fx-kpis" });
  const net = h("div", { class: "fx-net", "aria-label": "Red de agentes de la fábrica" });
  const lanes = h("div", { class: "fx-lanes" });
  const reg = h("section", { class: "fx-panel" });
  const feed = h("ol", { class: "fx-feed" });
  const human = h("section", { class: "fx-panel" });
  root.append(top, h("form", { class: "fx-cmdbar", onsubmit: send }, cmd, h("button", { class: "fx-go", type: "submit" }, "Crear misión")),
    h("p", { class: "fx-how" }, "Dile qué quieres y se convierte en una misión: cada día la fábrica crea esa cantidad sola (idea → diseño → pruebas → seguridad → publicación), aunque cierres el navegador, hasta que pulses Parar."),
    missionsEl, gallery, kpis, net, lanes, h("div", { class: "fx-cols" }, reg, h("div", { class: "fx-side" }, h("section", { class: "fx-panel" }, h("h3", {}, "Actividad en vivo"), feed), human)));

  const render = () => {
    const d = data, s = d.settings;
    root.style.setProperty("--fx-bg", FX_THEMES[s.theme] || FX_THEMES.cobalt);
    top.replaceChildren(
      h("div", {}, h("p", { class: "fx-kicker" }, "Autonomous Project Factory"), h("h1", {}, "Kairo Factory")),
      h("div", { class: "fx-top-r" },
        h("span", { class: "fx-state" + (s.enabled ? " on" : "") }, s.enabled ? "● En marcha 24/7" : "○ En pausa"),
        h("button", { class: "fx-go ghost", type: "button", onclick: settings }, "Ajustes"),
        h("button", { class: "fx-go", type: "button", onclick: async () => { await api("POST", `/api/factory/${s.enabled ? "pause" : "start"}`); load(); } }, s.enabled ? "Pausar" : "Arrancar")));
    renderMissions(d);
    renderGallery(d);
    const t = d.totals;
    kpis.replaceChildren(...[
      ["En producción", t.live], ["Creados hoy", t.today], ["Publicadas hoy", t.live_today],
      ["En cadena", Object.entries(d.counts).filter(([k]) => !["live", "maintenance"].includes(k)).reduce((a, [, v]) => a + v, 0)],
      ["Tokens hoy", `${Number(t.tokens_today).toLocaleString("es-ES")} / ${Number(s.token_budget_day).toLocaleString("es-ES")}`],
      ["Descartadas · fallidas", `${t.rejected} · ${t.failed}`],
    ].map(([k, v]) => h("div", { class: "fx-kpi" }, h("b", {}, String(v)), h("span", {}, k))));
    drawNet(d);
    lanes.replaceChildren(...d.stages.map((st) => {
      const ps = d.projects.filter((p) => p.stage === st && !["rejected"].includes(p.status));
      return h("div", { class: "fx-lane" }, h("div", { class: "fx-lane-h" }, h("span", {}, FX_STAGE_LABEL[st]), h("b", {}, String(ps.length))),
        h("div", { class: "fx-lane-b" }, ps.slice(0, 6).map((p) => h("button", { type: "button", class: "fx-chipp" + (p.status === "working" ? " busy" : "") + (p.status === "failed" ? " bad" : ""), onclick: () => openProject(p.id) },
          h("i", { style: `background:${p.accent || "#fff"}` }), h("span", {}, p.name))), ps.length > 6 ? h("small", {}, `+${ps.length - 6}`) : null));
    }));
    reg.replaceChildren(h("div", { class: "fx-panel-h" }, h("h3", {}, `Registro de proyectos · ${d.projects.length}`), h("a", { class: "fx-link", href: "/s/", target: "_blank", rel: "noopener" }, "Escaparate público ↗")),
      d.projects.length ? h("div", { class: "fx-tablewrap" }, h("table", { class: "fx-tbl" },
        h("thead", {}, h("tr", {}, ["Proyecto", "Nicho", "Etapa", "Estado", "URL", "APIs", "Creado", "Auditoría"].map((x) => h("th", { scope: "col" }, x)))),
        h("tbody", {}, d.projects.map((p) => h("tr", { class: "fx-row", onclick: () => openProject(p.id) },
          h("td", {}, h("b", {}, p.name), h("small", {}, trunc(p.tagline || p.idea || "", 60))),
          h("td", {}, FX_NICHE[p.niche] || p.niche), h("td", {}, FX_STAGE_LABEL[p.stage] || p.stage),
          h("td", {}, h("span", { class: `fx-st s-${p.status}` }, FX_STATUS[p.status] || p.status)),
          h("td", {}, p.url && p.version ? h("a", { href: p.url, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation() }, "Abrir ↗") : "—"),
          h("td", { class: "fx-small" }, (p.apis || []).join(", ") || "—"),
          h("td", { class: "fx-small" }, fmtDate(p.created_at)), h("td", { class: "fx-small" }, p.last_audit_at ? fmtDate(p.last_audit_at) : "—")))))) :
        h("div", { class: "fx-empty" }, h("b", {}, "La fábrica está vacía."), h("p", {}, "Escribe una orden arriba (p. ej. «Crea proyectos nuevos de meme coins») o pulsa Arrancar para que genere ideas sola.")));
    feed.replaceChildren(...d.events.slice(0, 40).map((e) => h("li", { class: `k-${e.kind}` }, h("time", {}, fmtTime(e.created_at)), h("b", {}, e.agent), " ", e.project ? h("span", { class: "fx-p" }, `${e.project} · `) : null, e.message)));
    human.replaceChildren(h("h3", {}, "Solo tú decides"), h("p", { class: "fx-small" }, "Todo lo demás lo hace la fábrica sola. Esto requiere tu autorización:"),
      h("ul", { class: "fx-human" }, d.approvals.map((a) => h("li", {}, h("b", {}, a.title), h("span", {}, a.detail)))));
  };

  function renderMissions(d) {
    const ms = d.missions || [];
    if (!ms.length) {
      missionsEl.replaceChildren(h("div", { class: "fx-mission empty" }, h("b", {}, "Sin misiones todavía."), h("p", {}, "Prueba: «Créame criptomonedas» (10 al día con logo, nombre, lore y web) o «Hazme webs de deportes»."),
        h("div", { class: "fx-acts" }, ["Créame criptomonedas", "Hazme webs de deportes", "Webs de inteligencia artificial"].map((x) => h("button", { class: "fx-go small ghost", type: "button", onclick: () => { cmd.value = x; send(); } }, x)))));
      return;
    }
    missionsEl.replaceChildren(...ms.map((m) => {
      const pct = Math.min(100, Math.round((m.made_today / m.per_day) * 100));
      const per = h("input", { type: "number", min: 1, max: 50, value: m.per_day, "aria-label": "Cantidad al día", onchange: async (e) => { try { await api("PATCH", `/api/factory/missions/${m.id}`, { per_day: +e.target.value }); load(); } catch (err) { toast(err.message, true); } } });
      return h("article", { class: "fx-mission" + (m.active ? " on" : "") },
        h("header", {}, h("span", { class: "fx-mk" }, m.kind === "memecoin" ? "Meme coins" : FX_NICHE[m.niche] || m.niche), h("span", { class: "fx-state" + (m.active ? " on" : "") }, m.active ? (m.working ? "● trabajando" : "● activa") : "○ parada")),
        h("h3", {}, m.title), h("p", { class: "fx-small" }, `«${trunc(m.prompt, 90)}»`),
        h("div", { class: "fx-prog", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": m.per_day, "aria-valuenow": m.made_today }, h("i", { style: `width:${pct}%` })),
        h("label", { class: "fx-mrow" }, "Trabaja con ", csAiSelect(m.ai_pref, async (v) => { await api("PATCH", `/api/factory/missions/${m.id}`, { ai_pref: v }); toast("IA de la producción cambiada: lo pendiente sigue con ella"); load(); })),
        h("p", { class: "fx-mrow" }, h("span", {}, h("b", {}, `${m.made_today}/${m.per_day}`), " hoy"), h("span", {}, h("b", {}, String(m.live_total)), " publicadas"), h("label", { class: "fx-per" }, per, " al día")),
        h("div", { class: "fx-acts" },
          h("button", { class: "fx-go small" + (m.active ? " ghost" : ""), type: "button", onclick: async () => { await api("PATCH", `/api/factory/missions/${m.id}`, { active: !m.active }); load(); } }, m.active ? "Parar" : "Reanudar"),
          h("button", { class: "fx-go small ghost", type: "button", onclick: async () => {
            if (!(await confirmDialog({ title: "Borrar misión", body: `Se borra la orden «${m.title}». Lo ya creado se queda en el registro.`, confirmLabel: "Borrar", danger: true }))) return;
            await api("DELETE", `/api/factory/missions/${m.id}`); load(); } }, "Borrar")));
    }));
  }

  function renderGallery(d) {
    const live = d.projects.filter((p) => p.version > 0 && (p.stage === "live" || p.stage === "maintenance")).slice(0, 24);
    if (!live.length) { gallery.replaceChildren(h("div", { class: "fx-panel-h" }, h("h3", {}, "Creaciones")), h("p", { class: "fx-small" }, "Aquí aparecerá cada criptomoneda y cada web en cuanto pase las pruebas y se publique.")); return; }
    gallery.replaceChildren(h("div", { class: "fx-panel-h" }, h("h3", {}, `Creaciones · ${live.length}`), h("a", { class: "fx-link", href: "/s/", target: "_blank", rel: "noopener" }, "Ver todas ↗")),
      h("div", { class: "fx-gal" }, live.map((p) => h("a", { class: "fx-gcard", href: p.url, target: "_blank", rel: "noopener", style: `--c:${p.accent || "#fff"};--b:${p.bg || "#111"}` },
        p.kind === "memecoin" ? h("img", { src: `/s/${p.slug}/logo`, alt: `Logo de ${p.name}`, loading: "lazy", width: 96, height: 96 }) : h("span", { class: "fx-gweb", "aria-hidden": "true" }, p.name.slice(0, 1).toUpperCase()),
        h("b", {}, p.name), h("small", {}, p.kind === "memecoin" ? `$${p.ticker || "?"}` : FX_NICHE[p.niche] || p.niche)))));
  }

  function drawNet(d) {
    const W = 1000, H = 300, colW = W / FX_CLUSTERS.length;
    const pos = {};
    FX_CLUSTERS.forEach(([, ids], ci) => ids.forEach((id, i) => { pos[id] = [colW * ci + colW / 2, H / 2 + (i - (ids.length - 1) / 2) * 44]; }));
    const agents = Object.fromEntries(d.agents.map((a) => [a.id, a]));
    const edges = [];
    for (let c = 0; c < FX_CLUSTERS.length - 1; c++) for (const a of FX_CLUSTERS[c][1]) for (const b of FX_CLUSTERS[c + 1][1]) edges.push([a, b]);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "fx-svg"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Red de ${d.agents.length} agentes; ${d.agents.filter((a) => a.active).length} trabajando ahora`);
    const mk = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
    edges.forEach(([a, b], i) => {
      const [x1, y1] = pos[a], [x2, y2] = pos[b], mx = (x1 + x2) / 2;
      const path = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
      const hot = agents[a]?.active || agents[b]?.active;
      svg.append(mk("path", { d: path, class: "fx-edge" + (hot ? " hot" : "") }));
      if (hot) { const dot = mk("circle", { r: 3.2, class: "fx-dot" }); const am = mk("animateMotion", { dur: `${1.6 + (i % 5) * 0.25}s`, repeatCount: "indefinite", path }); dot.append(am); svg.append(dot); }
    });
    FX_CLUSTERS.forEach(([st], ci) => { const t = mk("text", { x: colW * ci + colW / 2, y: 22, class: "fx-col-t", "text-anchor": "middle" }); t.textContent = FX_STAGE_LABEL[st].toUpperCase(); svg.append(t); });
    for (const [id, [x, y]] of Object.entries(pos)) {
      const a = agents[id];
      const g = mk("g", { class: "fx-node" + (a?.active ? " on" : ""), transform: `translate(${x},${y})` });
      if (a?.active) g.append(mk("circle", { r: 15, class: "fx-ring" }));
      g.append(mk("circle", { r: 9, class: "fx-core" }));
      const t = mk("text", { x: 16, y: 4, class: "fx-lbl" }); t.textContent = a?.name || id; g.append(t);
      const tt = mk("title", {}); tt.textContent = `${a?.name}: ${a?.does}${a?.projects?.length ? ` — ahora: ${a.projects.join(", ")}` : ""}`; g.append(tt);
      svg.append(g);
    }
    net.replaceChildren(svg);
  }

  async function openProject(id) {
    sel = id;
    const p = await api("GET", `/api/factory/projects/${id}`);
    drawer?.remove();
    const checks = [...(p.checks.qa || []), ...(p.checks.security || [])];
    const act = (a, label, cls = "") => h("button", { class: "fx-go small " + cls, type: "button", onclick: async () => {
      if (a === "delete" && !(await confirmDialog({ title: "Borrar proyecto", body: `Se borra «${p.name}» y su web publicada.`, confirmLabel: "Borrar", danger: true }))) return;
      try { await api("POST", `/api/factory/projects/${id}/${a}`); toast("Hecho"); drawer?.remove(); drawer = null; load(); } catch (e) { toast(e.message, true); } } }, label);
    drawer = h("aside", { class: "fx-drawer", role: "dialog", "aria-label": p.name },
      h("header", {}, h("div", {}, h("p", { class: "fx-kicker" }, `${FX_NICHE[p.niche] || p.niche} · v${p.version}`), h("h2", {}, p.name)),
        h("button", { class: "fx-x", type: "button", "aria-label": "Cerrar", onclick: () => { drawer.remove(); drawer = null; } }, "✕")),
      p.kind === "memecoin" ? h("img", { class: "fx-dlogo", src: `/s/${p.slug}/logo`, alt: `Logo de ${p.name}`, width: 120, height: 120 }) : null,
      h("p", {}, p.spec.tagline || p.idea),
      h("div", { class: "fx-meta" }, ...[["Etapa", FX_STAGE_LABEL[p.stage]], ["Estado", FX_STATUS[p.status] || p.status], ["Puntuación", p.research.score ? `${p.research.score}/10` : "—"], ["Stack", p.stack], ["APIs", p.apis.join(", ") || "—"], ["Peso", `${p.html_kb} KB`], ["Repositorio", p.repo || "—"]].map(([k, v]) => h("div", {}, h("span", {}, k), h("b", {}, v)))),
      h("label", { class: "fx-mrow" }, "IA de este proyecto ", csAiSelect(p.ai_pref, async (v) => {
        await api("POST", `/api/factory/projects/${id}/ai`, { ai_pref: v, resume: true }); toast("El proyecto sigue con la IA elegida"); drawer?.remove(); drawer = null; load();
      }), p.last_ai ? h("small", {}, ` · última: ${csAiLabel(p.last_ai)}`) : null),
      p.url && p.version ? h("div", { class: "fx-prev" }, h("iframe", { src: p.url, title: `Vista previa de ${p.name}`, sandbox: "allow-scripts allow-popups", loading: "lazy" }), h("a", { class: "fx-link", href: p.url, target: "_blank", rel: "noopener" }, `${p.url} ↗`)) : null,
      p.errors ? h("p", { class: "fx-err" }, p.errors) : null,
      h("div", { class: "fx-acts" }, act("retry", "Reintentar"), act("rebuild", "Reconstruir"), p.version > 1 ? act("rollback", "Volver a la versión anterior") : null, act("pause", "Pausar", "ghost"), act("delete", "Borrar", "ghost")),
      checks.length ? h("details", { class: "fx-det", open: true }, h("summary", {}, `Pruebas y seguridad · ${checks.filter((c) => c.ok).length}/${checks.length}`), h("ul", { class: "fx-checks" }, checks.map((c) => h("li", { class: c.ok ? "ok" : c.required ? "bad" : "warn" }, c.ok ? "✓ " : "✕ ", c.detail)))) : null,
      p.research.audience ? h("details", { class: "fx-det" }, h("summary", {}, "Investigación"), p.research.inspired_by ? h("p", {}, `Copia original inspirada en: ${p.research.inspired_by} (con marca y textos propios)`) : null, h("p", {}, `Público: ${p.research.audience}`), h("p", {}, `Valor: ${p.research.value || "—"}`), h("p", {}, `Monetización: ${(p.research.monetization || []).join(", ")}`), h("p", {}, `Riesgos: ${(p.research.risks || []).join(", ")}`)) : null,
      h("details", { class: "fx-det", open: true }, h("summary", {}, "Historial de agentes"), h("ol", { class: "fx-feed" }, p.events.map((e) => h("li", { class: `k-${e.kind}` }, h("time", {}, fmtTime(e.created_at)), h("b", {}, e.agent), " ", e.message)))));
    root.append(drawer);
  }

  async function settings() {
    const s = data.settings;
    const conns = (await api("GET", "/api/dashboard").catch(() => ({ connectors: [] }))).connectors.filter((c) => c.type === "github");
    const num = (v, min, max) => h("input", { type: "number", min, max, value: v });
    const target = num(s.daily_target, 1, 50), par = num(s.max_parallel, 1, 6), budget = num(s.token_budget_day, 20000, 5000000);
    const auto = h("input", { type: "checkbox", checked: s.auto_ideas ? true : null });
    const theme = h("select", {}, Object.keys(FX_THEMES).map((k) => h("option", { value: k, selected: k === s.theme ? true : null }, k)));
    const gh = h("select", {}, h("option", { value: "" }, "Sin exportar a GitHub"), conns.map((c) => h("option", { value: c.id, selected: c.id === s.github_connector_id ? true : null }, c.name)));
    const niches = data.niches.map((id) => {
      const cur = s.niches.find((n) => n.id === id) || { id, weight: 1, enabled: false };
      const en = h("input", { type: "checkbox", checked: cur.enabled ? true : null }), w = h("input", { type: "range", min: 0, max: 10, value: cur.weight });
      return { id, en, w, row: h("label", { class: "fx-niche" }, en, h("span", {}, FX_NICHE[id]), w) };
    });
    openDialog("Ajustes de la fábrica", [
      h("div", { class: "row" }, field("Ideas sueltas al día (sin misiones)", target), field("En paralelo", par)),
      field("Presupuesto de tokens al día", budget, "Cuando se alcanza, la fábrica para y sigue sola al día siguiente."),
      h("label", { class: "switch" }, auto, "Si no hay misiones, generar ideas sola por nichos"),
      h("div", {}, h("div", { class: "mono-up" }, "Nichos y prioridad"), ...niches.map((n) => n.row)),
      h("div", { class: "row" }, field("Color de la pantalla", theme), field("Exportar código a GitHub", gh, "Rama «factory» del repo del conector. Nunca toca main.")),
    ], [h("button", { class: "btn", type: "button", onclick: () => closeDialog(false) }, "Cancelar"), h("button", { class: "btn primary", type: "button", onclick: async () => {
      try {
        await api("PUT", "/api/factory/settings", { daily_target: +target.value, max_parallel: +par.value, token_budget_day: +budget.value, auto_ideas: auto.checked, theme: theme.value, github_connector_id: gh.value ? +gh.value : null, niches: niches.map((n) => ({ id: n.id, enabled: n.en.checked, weight: +n.w.value })) });
        closeDialog(true); toast("Ajustes guardados"); load();
      } catch (e) { toast(e.message, true); }
    } }, "Guardar")]);
  }

  async function load() {
    data = await api("GET", "/api/factory");
    if (document.activeElement?.tagName === "INPUT" && missionsEl.contains(document.activeElement)) return; // no pisar lo que estás escribiendo
    render();
  }
  await load();
  every(3000, load);
}
