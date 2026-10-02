/* Lienzo → Oficina 3D de robots · parqué de Wall Street.
 *
 * - Cada robot del equipo tiene su mesa con ordenador; cada proyecto, su mesa con holograma.
 * - Los robots se conectan con proyectos (toca un robot → marca sus proyectos).
 * - Cuando un proyecto trabaja de verdad (o Kairo usa a un robot en una ejecución), el robot
 *   se levanta, va al tablón a por la tarea y trabaja en la mesa del proyecto. Si Kairo usa a
 *   un agente que no está en la oficina, entra por la puerta como visitante.
 * - Equipo y conexiones se guardan en las preferencias del usuario (servidor).
 */
"use strict";

const cvState = () => {
  const c = PREFS.data.canvas || {};
  return { nodes: Array.isArray(c.nodes) ? c.nodes : [], links: Array.isArray(c.links) ? c.links : [], seeded: !!c.seeded };
};
let cvSaveTimer = null;
function cvSave(st) {
  PREFS.data.canvas = st;
  clearTimeout(cvSaveTimer);
  cvSaveTimer = setTimeout(() => setPrefs({ canvas: { nodes: st.nodes, links: st.links, seeded: true } }), 400);
}
const assetVersion = () => (document.querySelector('script[src*="canvas.js"]')?.src.match(/v=(\d+)/) || [])[1] || "1";

async function viewCanvas(main) {
  const [reg, dash0] = await Promise.all([api("GET", "/api/chat/agents"), api("GET", "/api/dashboard")]);
  let dash = dash0;
  const agents = new Map(reg.agents.map((a) => [a.id, a]));
  let projects = new Map(dash.projects.map((p) => [p.id, p]));
  const st = cvState();
  if (!st.seeded) {
    st.nodes = [
      ...reg.agents.filter((a) => !a.locked).slice(0, 6).map((a) => ({ t: "a", id: a.id, x: 0, y: 0 })),
      ...dash.projects.slice(0, 4).map((p) => ({ t: "p", id: p.id, x: 0, y: 0 })),
    ];
    st.seeded = true;
    cvSave(st);
  }
  st.nodes = st.nodes.filter((n) => (n.t === "a" ? agents.has(n.id) : projects.has(n.id)));
  st.links = st.links.filter((l) => agents.has(l.a) && projects.has(l.p));
  let demo = false;

  // --- interfaz
  const stage = h("div", { class: "of-stage", "aria-label": "Oficina 3D de robots" });
  const panel = h("aside", { class: "of-panel", hidden: true });
  const count = h("span", { class: "of-count" });
  const demoBtn = h("button", { class: "btn small", type: "button", "aria-pressed": "false", title: "Ver cómo trabajan sin lanzar una tarea real" }, icon("play", 14), "Modo demo");
  const toolbar = h("div", { class: "of-toolbar" },
    h("div", { class: "grow" }, h("div", { class: "eyebrow" }, "Agentes · parqué de Wall Street"), h("h1", {}, "Oficina de robots"),
      h("p", { class: "small muted" }, "Tu parqué de agentes. Toca un robot para ver su ficha o su ordenador para ver qué le han pedido y qué está generando, en directo.")),
    count,
    h("div", { class: "row of-actions" },
      h("button", { class: "btn small", type: "button", onclick: () => pickDialog("a") }, icon("plus", 14), "Robot"),
      h("button", { class: "btn small", type: "button", onclick: () => pickDialog("p") }, icon("plus", 14), "Proyecto"),
      demoBtn));
  const camBar = h("div", { class: "of-cam" },
    h("button", { type: "button", "aria-label": "Acercar", onclick: () => off?.zoom(1.2) }, "+"),
    h("button", { type: "button", "aria-label": "Alejar", onclick: () => off?.zoom(1 / 1.2) }, "−"),
    h("button", { type: "button", "aria-label": "Girar la vista", onclick: () => off?.rotate() }, icon("refresh", 15)),
    h("button", { type: "button", "aria-label": "Centrar", onclick: () => off?.reset() }, icon("grid", 15)));
  const legend = h("div", { class: "of-legend" },
    h("span", {}, "Toca un robot · su ficha"), h("span", {}, "Toca su ordenador · qué hace"), h("span", {}, "Arrastra · moverte"), h("span", { class: "of-legend-desk" }, "Mayús + arrastrar · girar"));
  // Buscador: encuentra cualquier agente y vuela hasta su puesto
  const find = h("input", { type: "search", class: "of-find", placeholder: "Buscar agente…", "aria-label": "Buscar agente en la oficina", autocomplete: "off" });
  const findList = h("div", { class: "of-find-list", hidden: true });
  const findBox = h("div", { class: "of-find-box" }, find, findList);
  const computer = h("section", { class: "of-pc", hidden: true, role: "dialog", "aria-label": "Ordenador del agente" });
  main.replaceChildren(h("div", { class: "of" }, toolbar, h("div", { class: "of-wrap" }, stage, findBox, camBar, legend, panel, computer)));

  let off = null;
  try {
    const mod = await import(`/office3d.js?v=${assetVersion()}`);
    off = mod.mountOffice(stage, {
      projectName: (id) => projects.get(id)?.name || "proyecto",
      onBot: (id) => showBot(id),
      onComputer: (id) => showComputer(id),
      onStation: (id) => showProject(id),
      onEmpty: () => { panel.hidden = true; },
    });
  } catch (err) {
    stage.replaceChildren(empty("No se pudo cargar la oficina 3D", `Tu navegador no admite WebGL o falló la carga (${err.message}).`));
    return;
  }

  const team = () => st.nodes.filter((n) => n.t === "a").map((n) => agents.get(n.id)).filter(Boolean);
  const officeProjects = () => {
    const ids = st.nodes.filter((n) => n.t === "p").map((n) => n.id);
    return (ids.length ? ids : [...projects.keys()].slice(0, 4)).map((id) => projects.get(id)).filter(Boolean);
  };
  const rebuild = () => {
    off.build({
      agents: team(),
      projects: officeProjects().map((p) => ({ id: p.id, name: p.name, color: p.color, live: p.live > 0, sub: `${(p.runs || 0) + (p.kairo_runs || 0)} tareas` })),
    });
    const teamIds = new Set(team().map((a) => a.id));
    const floorAgents = reg.agents.filter((a) => !teamIds.has(a.id)).slice(0, off.capacity); // el resto entra por la puerta cuando trabaja
    off.setCrowd(floorAgents);
    count.textContent = `${team().length} en tu equipo · ${floorAgents.length} en el parqué · ${reg.agents.length} agentes`;
    applyWork();
    refreshScreens();
  };

  // Qué hace cada robot ahora mismo (datos reales + modo demo).
  const applyWork = () => {
    const map = new Map();
    const inOffice = new Set(team().map((a) => a.id));
    const stationIds = new Set(officeProjects().map((p) => p.id));
    for (const l of st.links) if (projects.get(l.p)?.live > 0 && inOffice.has(l.a)) map.set(l.a, l.p);
    const visitors = [];
    for (const w of dash.working_agents || []) {
      const where = w.project_id && stationIds.has(w.project_id) ? w.project_id : "kairo";
      if (inOffice.has(w.agent_id)) map.set(w.agent_id, where);
      else if (agents.has(w.agent_id) && visitors.length < 6) visitors.push({ agent: agents.get(w.agent_id), work: where });
    }
    if (demo) {
      let k = 0;
      for (const a of team()) {
        const link = st.links.find((l) => l.a === a.id && stationIds.has(l.p));
        if (link) map.set(a.id, link.p);
        else if (k++ % 2 === 0) map.set(a.id, "kairo");
      }
    }
    off.setLive(new Set(officeProjects().filter((p) => p.live > 0 || (demo && st.links.some((l) => l.p === p.id))).map((p) => p.id)));
    off.setWork(map, visitors);
  };

  // Videowall y teletipo con datos reales del panel.
  const applyBoard = () => {
    const working = new Set((dash.working_agents || []).map((w) => w.agent_id)).size;
    const live = dash.projects.filter((p) => p.live > 0);
    const t = dash.totals || {};
    off.setBoard({
      kpis: [
        { label: "Agentes", value: reg.agents.length.toLocaleString("es-ES") },
        { label: "Trabajando", value: working, tone: working ? "live" : null },
        { label: "Proyectos live", value: live.length, tone: live.length ? "up" : null },
        { label: "Tareas", value: (t.runs || 0).toLocaleString("es-ES") },
        { label: "Tokens hoy", value: Number(t.tokens_today || 0).toLocaleString("es-ES") },
      ],
      ticker: [
        ...live.map((p) => ({ text: `${p.name.toUpperCase()} ● LIVE`, tone: "live" })),
        ...(dash.working_agents || []).slice(0, 10).map((w) => ({ text: `${(agents.get(w.agent_id)?.name || w.agent_id).toUpperCase()} ▲ TRABAJANDO`, tone: "up" })),
        ...dash.projects.slice(0, 12).map((p) => ({ text: `${p.name.toUpperCase()} ${(p.runs || 0) + (p.kairo_runs || 0)} TAREAS`, tone: p.failed ? "down" : null })),
        { text: `KAIRO · ${reg.agents.length} AGENTES`, tone: "live" },
        { text: `HECHAS ${(t.completed || 0).toLocaleString("es-ES")} ▲`, tone: "up" },
        ...(t.failed ? [{ text: `FALLIDAS ${t.failed} ▼`, tone: "down" }] : []),
      ],
    });
  };
  // Pantalla central de cada puesto de tu equipo: lo último que ha hecho cada agente (real).
  let screenBusy = false;
  async function refreshScreens() {
    const ids = team().map((a) => a.id);
    if (!ids.length || screenBusy) return;
    screenBusy = true;
    try {
      const r = await api("GET", `/api/chat/agents-activity?ids=${encodeURIComponent(ids.join(","))}`);
      off.setScreens(new Map(Object.entries(r.agents).map(([id, list]) => [id, list[0]])));
    } catch { /* la oficina sigue funcionando sin pantallas */ } finally { screenBusy = false; }
  }

  demoBtn.addEventListener("click", () => {
    demo = !demo;
    demoBtn.setAttribute("aria-pressed", String(demo));
    demoBtn.replaceChildren(icon(demo ? "stop" : "play", 14), demo ? "Parar demo" : "Modo demo");
    if (demo && !st.links.length) toast("Consejo: conecta robots a proyectos (toca un robot) para verlos ir a su mesa.");
    applyWork();
  });

  // --- paneles de detalle
  function showBot(id) {
    const a = agents.get(id);
    if (!a) return;
    closeComputer();
    const onTeam = team().some((x) => x.id === id);
    const linked = new Set(st.links.filter((l) => l.a === id).map((l) => l.p));
    panel.hidden = false;
    panel.replaceChildren(
      h("div", { class: "of-panel-h" }, h("span", { class: "of-bot" }, agentRobot(a, "idle", 46)),
        h("div", { class: "grow" }, h("b", {}, a.name), h("small", {}, `${a.category_label}${a.locked ? " · PRO" : ""}${onTeam ? "" : " · visitante"}`)),
        h("button", { class: "btn small ghost icon-only", type: "button", "aria-label": "Cerrar", onclick: () => { panel.hidden = true; } }, icon("close", 16))),
      h("p", { class: "small muted" }, a.description),
      h("div", { class: "row", style: "gap:8px" },
        h("button", { class: "btn small primary", type: "button", onclick: () => showComputer(id) }, icon("cpu", 14), "Ver su ordenador"),
        h("button", { class: "btn small", type: "button", onclick: () => off.focus(id) }, "Ir a su puesto")),
      onTeam ? h("div", { class: "stack", style: "gap:6px" }, h("label", {}, "Trabaja en"),
        ...[...projects.values()].map((p) => {
          const cb = h("input", { type: "checkbox", checked: linked.has(p.id) ? true : null });
          cb.addEventListener("change", () => {
            st.links = cb.checked ? [...st.links, { a: id, p: p.id }] : st.links.filter((l) => !(l.a === id && l.p === p.id));
            if (cb.checked && !st.nodes.some((n) => n.t === "p" && n.id === p.id)) st.nodes.push({ t: "p", id: p.id, x: 0, y: 0 });
            cvSave(st); rebuild();
          });
          return h("label", { class: "switch" }, cb, p.name, p.live > 0 ? h("span", { class: "live-tag", style: "margin-left:6px" }, "LIVE") : null);
        })) : h("button", { class: "btn small primary", type: "button", onclick: () => { st.nodes.push({ t: "a", id, x: 0, y: 0 }); cvSave(st); rebuild(); showBot(id); } }, icon("plus", 14), "Contratar en la oficina"),
      onTeam ? h("button", { class: "btn small danger", type: "button", onclick: () => {
        st.nodes = st.nodes.filter((n) => !(n.t === "a" && n.id === id)); st.links = st.links.filter((l) => l.a !== id);
        cvSave(st); panel.hidden = true; rebuild();
      } }, "Quitar de la oficina") : null);
  }

  function showProject(id) {
    const p = projects.get(id);
    if (!p) return;
    const bots = st.links.filter((l) => l.p === id).map((l) => agents.get(l.a)).filter(Boolean);
    panel.hidden = false;
    panel.replaceChildren(
      h("div", { class: "of-panel-h" }, h("span", { class: `of-pdot col-${p.color || "azul"}` }),
        h("div", { class: "grow" }, h("b", {}, p.name), h("small", {}, `${(p.runs || 0) + (p.kairo_runs || 0)} tareas${p.live > 0 ? " · trabajando ahora" : ""}`)),
        h("button", { class: "btn small ghost icon-only", type: "button", "aria-label": "Cerrar", onclick: () => { panel.hidden = true; } }, icon("close", 16))),
      h("label", {}, `Robots conectados · ${bots.length}`),
      bots.length ? h("div", { class: "of-team" }, bots.map((a) => h("button", { type: "button", class: "of-mini", title: a.name, onclick: () => showBot(a.id) }, agentRobot(a, p.live > 0 ? "running" : "idle", 30), h("small", {}, a.name))))
        : h("p", { class: "small muted" }, "Toca un robot y marca este proyecto para asignarlo."),
      h("div", { class: "row", style: "gap:8px;margin-top:6px" },
        h("button", { class: "btn small primary", type: "button", disabled: bots.length ? null : true, onclick: () => workWith(p, bots) }, icon("bolt", 14), bots.length ? `Trabajar con ${bots.length}` : "Trabajar"),
        h("a", { class: "btn small", href: `#/p/${p.id}/overview` }, "Abrir proyecto")),
      h("button", { class: "btn small ghost", type: "button", onclick: () => {
        st.nodes = st.nodes.filter((n) => !(n.t === "p" && n.id === id)); cvSave(st); panel.hidden = true; rebuild();
      } }, "Quitar mesa de la oficina"));
  }

  // --- ordenador del agente: qué le pidieron, qué genera y su historial (datos reales)
  let pcTimer = null, pcId = null;
  async function showComputer(id) {
    const a = agents.get(id);
    if (!a) return;
    pcId = id; panel.hidden = true;
    clearInterval(pcTimer);
    computer.hidden = false;
    let tab = "out", items = [], sel = 0;
    const body = h("div", { class: "of-pc-body" });
    const tabs = h("div", { class: "of-pc-tabs", role: "tablist" });
    const status = h("span", { class: "of-pc-status" });
    computer.replaceChildren(
      h("header", { class: "of-pc-h" },
        h("span", { class: "of-pc-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
        h("span", { class: "of-pc-title" }, agentRobot(a, "idle", 22), h("b", {}, a.name), h("small", {}, a.category_label)),
        status,
        h("button", { class: "of-pc-x", type: "button", "aria-label": "Cerrar", onclick: closeComputer }, icon("close", 15))),
      tabs, body);
    const render = () => {
      const cur = items[sel];
      status.className = "of-pc-status" + (cur?.live ? " live" : "");
      status.textContent = cur ? (cur.live ? `● ${cur.action || cur.status}` : cur.status === "COMPLETED" || cur.status === "completed" ? "✓ terminado" : cur.status) : "en espera";
      tabs.replaceChildren(...[["out", "Salida"], ["req", "Petición"], ["log", `Historial · ${items.length}`]].map(([k, l]) =>
        h("button", { type: "button", role: "tab", "aria-selected": String(tab === k), class: tab === k ? "on" : "", onclick: () => { tab = k; render(); } }, l)));
      if (!cur) { body.replaceChildren(h("div", { class: "of-pc-empty" }, h("b", {}, "Sin trabajo todavía"), h("p", {}, `Cuando Kairo, un proyecto o el Agent Hub usen a ${a.name}, aquí verás la petición y lo que genera, en directo.`), h("a", { class: "btn small primary", href: "#/chat" }, "Pedirle algo en Kairo"))); return; }
      if (tab === "req") body.replaceChildren(h("div", { class: "of-pc-meta" }, `${cur.source === "hub" ? "Agent Hub" : "Kairo"} · ${fmtDate(cur.at)}`), h("pre", { class: "of-pc-pre" }, cur.request || cur.task || "—"), cur.task && cur.request ? h("div", { class: "of-pc-meta" }, "Su parte del plan") : null, cur.task && cur.request ? h("pre", { class: "of-pc-pre" }, cur.task) : null);
      else if (tab === "log") body.replaceChildren(h("ol", { class: "of-pc-log" }, items.map((x, i) => h("li", {}, h("button", { type: "button", class: i === sel ? "on" : "", onclick: () => { sel = i; tab = "out"; render(); } },
        h("span", { class: "of-pc-dot" + (x.live ? " live" : x.status === "ERROR" || x.status === "failed" ? " err" : "") }), h("span", { class: "grow" }, trunc(x.request || x.task || "—", 80)), h("small", {}, fmtTime(x.at)))))));
      else {
        const pre = h("div", { class: "of-pc-code" });
        // Bloques de código resaltados, el resto como texto
        String(cur.output || (cur.live ? "" : cur.error || "—")).split(/(```[\s\S]*?(?:```|$))/).forEach((chunk) => {
          if (chunk.startsWith("```")) { const m = chunk.match(/^```(\w*)\n?([\s\S]*?)(?:```)?$/); pre.append(h("pre", { class: "of-pc-pre code" }, m?.[1] ? h("span", { class: "of-pc-lang" }, m[1]) : null, m ? m[2] : chunk)); }
          else if (chunk.trim()) pre.append(h("p", { class: "of-pc-text" }, chunk.trim()));
        });
        if (cur.live) pre.append(h("span", { class: "of-pc-caret", "aria-hidden": "true" }));
        body.replaceChildren(h("div", { class: "of-pc-meta" }, [cur.model, cur.execution_ms ? `${(cur.execution_ms / 1000).toFixed(1)} s` : null, cur.live && cur.progress ? `${cur.progress}%` : null].filter(Boolean).join(" · ") || " "), pre);
        if (cur.live) body.scrollTop = body.scrollHeight;
      }
    };
    const load = async () => {
      if (pcId !== id || computer.hidden) return;
      try { const r = await api("GET", `/api/chat/agents-activity?ids=${encodeURIComponent(id)}&limit=10`); items = r.agents[id] || []; } catch { items = items || []; }
      if (sel >= items.length) sel = 0;
      render();
    };
    render(); await load();
    pcTimer = setInterval(() => { if (!stage.isConnected) return clearInterval(pcTimer); if (items[sel]?.live || items.some((x) => x.live)) load(); }, 2000);
    off.focus(id);
  }
  function closeComputer() { computer.hidden = true; pcId = null; clearInterval(pcTimer); }
  document.addEventListener("keydown", function esc(e) { if (!stage.isConnected) return document.removeEventListener("keydown", esc); if (e.key === "Escape") { closeComputer(); panel.hidden = true; } });

  const renderFind = () => {
    const q = find.value.trim().toLowerCase();
    if (!q) { findList.hidden = true; return; }
    const hits = reg.agents.filter((a) => a.name.toLowerCase().includes(q) || (a.category_label || "").toLowerCase().includes(q)).slice(0, 8);
    findList.hidden = false;
    findList.replaceChildren(...(hits.length ? hits.map((a) => h("button", { type: "button", onclick: () => { find.value = ""; findList.hidden = true; off.focus(a.id); showBot(a.id); } },
      agentRobot(a, "idle", 24), h("span", { class: "grow" }, h("b", {}, a.name), h("small", {}, a.category_label)))) : [h("p", { class: "small muted" }, "Ningún agente con ese nombre.")]));
  };
  find.addEventListener("input", renderFind);
  find.addEventListener("keydown", (e) => { if (e.key === "Enter") findList.querySelector("button")?.click(); if (e.key === "Escape") { find.value = ""; renderFind(); } });

  async function workWith(p, bots) {
    const ids = bots.filter((a) => !a.locked).map((a) => a.id).slice(0, reg.max_agents_per_message);
    if (bots.length > ids.length) toast(`Tu plan permite ${reg.max_agents_per_message} agentes por mensaje: se usan los primeros.`);
    const t = await api("POST", "/api/chat/threads", { project_id: p.id, title: `${p.name} · oficina` });
    await api("PATCH", `/api/chat/threads/${t.id}`, { auto_mode: false, manual: { agents: ids, model: null, tools_off: [] } });
    location.hash = `#/chat/${t.id}`;
  }

  // --- añadir robots / proyectos
  function pickDialog(t) {
    const q = h("input", { type: "search", placeholder: t === "a" ? "Buscar robot" : "Buscar proyecto" });
    const list = h("div", { class: "cv-pick" });
    const onBoard = new Set(st.nodes.filter((n) => n.t === t).map((n) => n.id));
    const full = t === "a" ? team().length >= 16 : officeProjects().length >= 6 && st.nodes.some((n) => n.t === "p");
    const items = t === "a" ? reg.agents : [...projects.values()];
    const renderList = () => list.replaceChildren(...items.filter((x) => !onBoard.has(x.id) && (!q.value || x.name.toLowerCase().includes(q.value.toLowerCase()))).slice(0, 80).map((x) =>
      h("button", { type: "button", class: "cv-pick-item", onclick: () => {
        st.nodes.push({ t, id: x.id, x: 0, y: 0 }); closeDialog(true); cvSave(st); rebuild();
      } }, t === "a" ? agentRobot(x, "idle", 34) : h("span", { class: `cv-dot col-${x.color || "azul"}` }),
        h("span", { class: "grow" }, h("b", {}, x.name), h("small", {}, t === "a" ? `${x.category_label}${x.locked ? " · PRO" : ""}` : `${(x.runs || 0) + (x.kairo_runs || 0)} tareas`)))));
    q.addEventListener("input", renderList);
    renderList();
    openDialog(t === "a" ? "Contratar robot" : "Añadir mesa de proyecto", [
      full ? h("div", { class: "note small" }, t === "a" ? "La oficina tiene 16 mesas. Quita un robot para meter otro." : "Caben 6 mesas de proyecto. Quita una para añadir otra.") : null, q, list,
    ], [h("button", { class: "btn", type: "button", onclick: () => closeDialog(false) }, "Cerrar")]);
  }

  rebuild();
  applyBoard();
  off.start();
  // Estado vivo cada 4 s: proyectos trabajando y agentes en uso por Kairo.
  every(4000, async () => {
    if (!stage.isConnected) return;
    dash = await api("GET", "/api/dashboard");
    const before = [...projects.values()].map((p) => `${p.id}:${p.live}`).join();
    projects = new Map(dash.projects.map((p) => [p.id, p]));
    if (before !== dash.projects.map((p) => `${p.id}:${p.live}`).join()) rebuild();
    else { applyWork(); refreshScreens(); }
    applyBoard();
  });
}
