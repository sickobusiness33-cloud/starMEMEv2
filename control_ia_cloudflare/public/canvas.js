/* Lienzo → Oficina 3D de robots.
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
    h("div", { class: "grow" }, h("div", { class: "eyebrow" }, "Agentes · oficina 3D"), h("h1", {}, "Oficina de robots"),
      h("p", { class: "small muted" }, "Toca un robot para conectarlo a tus proyectos. Cuando un proyecto trabaja, sus robots se levantan, cogen la tarea del tablón y se ponen a ello.")),
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
    h("span", {}, "⌨️ en su mesa"), h("span", {}, "📋 coge tarea"), h("span", {}, "⚡ trabajando"), h("span", {}, "☕💧 descanso"));
  main.replaceChildren(h("div", { class: "of" }, toolbar, h("div", { class: "of-wrap" }, stage, camBar, legend, panel)));

  let off = null;
  try {
    const mod = await import(`/office3d.js?v=${assetVersion()}`);
    off = mod.mountOffice(stage, {
      projectName: (id) => projects.get(id)?.name || "proyecto",
      onBot: (id) => showBot(id),
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
    off.setCrowd(reg.agents.filter((a) => !teamIds.has(a.id)).slice(0, 280)); // la nave tiene 288 puestos; el resto entra como visitante al trabajar
    count.textContent = `${team().length} en tu equipo · ${Math.min(280, reg.agents.length)} en la nave · ${reg.agents.length} agentes en total · ${st.links.length} conexiones`;
    applyWork();
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
    const onTeam = team().some((x) => x.id === id);
    const linked = new Set(st.links.filter((l) => l.a === id).map((l) => l.p));
    panel.hidden = false;
    panel.replaceChildren(
      h("div", { class: "of-panel-h" }, h("span", { class: "of-bot" }, agentRobot(a, "idle", 46)),
        h("div", { class: "grow" }, h("b", {}, a.name), h("small", {}, `${a.category_label}${a.locked ? " · PRO" : ""}${onTeam ? "" : " · visitante"}`)),
        h("button", { class: "btn small ghost icon-only", type: "button", "aria-label": "Cerrar", onclick: () => { panel.hidden = true; } }, icon("close", 16))),
      h("p", { class: "small muted" }, a.description),
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
  off.start();
  // Estado vivo cada 4 s: proyectos trabajando y agentes en uso por Kairo.
  every(4000, async () => {
    if (!stage.isConnected) return;
    dash = await api("GET", "/api/dashboard");
    const before = [...projects.values()].map((p) => `${p.id}:${p.live}`).join();
    projects = new Map(dash.projects.map((p) => [p.id, p]));
    if (before !== dash.projects.map((p) => `${p.id}:${p.live}`).join()) rebuild();
    else applyWork();
  });
}
