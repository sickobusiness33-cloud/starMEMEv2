/* Lienzo de robots: arrastra agentes sobre un fondo y conéctalos con tus proyectos.
 *
 * - Posiciones y conexiones se guardan en las preferencias del usuario (servidor).
 * - Una conexión robot → proyecto significa «este robot trabaja en este proyecto»:
 *   el botón «Trabajar» del proyecto abre un chat del proyecto en modo manual con
 *   esos robots ya elegidos.
 * - Si el proyecto está trabajando ahora mismo, sus cables se iluminan.
 */
"use strict";

const CV = { board: null, W: 2400, H: 1500 };

const cvState = () => {
  const c = PREFS.data.canvas || {};
  return { nodes: Array.isArray(c.nodes) ? c.nodes : [], links: Array.isArray(c.links) ? c.links : [], seeded: !!c.seeded };
};
let cvSaveTimer = null;
function cvSave(st) {
  PREFS.data.canvas = st; // se aplica ya; el guardado en servidor va con retardo
  clearTimeout(cvSaveTimer);
  cvSaveTimer = setTimeout(() => setPrefs({ canvas: { nodes: st.nodes, links: st.links, seeded: true } }), 400);
}

async function viewCanvas(main) {
  const [reg, dash] = await Promise.all([api("GET", "/api/chat/agents"), api("GET", "/api/dashboard")]);
  const agents = new Map(reg.agents.map((a) => [a.id, a]));
  let projects = new Map(dash.projects.map((p) => [p.id, p]));
  let st = cvState();

  // Primera visita: unos cuantos robots y proyectos colocados para empezar.
  if (!st.seeded) {
    const bots = reg.agents.filter((a) => !a.locked).slice(0, 5);
    st.nodes = [
      ...bots.map((a, i) => ({ t: "a", id: a.id, x: 120 + (i % 3) * 170, y: 80 + Math.floor(i / 3) * 210 })),
      ...dash.projects.slice(0, 4).map((p, i) => ({ t: "p", id: p.id, x: 760, y: 50 + i * 185 })),
    ];
    st.seeded = true;
    cvSave(st);
  }
  // Limpia nodos de agentes/proyectos que ya no existen.
  st.nodes = st.nodes.filter((n) => (n.t === "a" ? agents.has(n.id) : projects.has(n.id)));
  st.links = st.links.filter((l) => agents.has(l.a) && projects.has(l.p));

  const board = h("div", { class: "cv-board", style: `width:${CV.W}px;height:${CV.H}px` });
  const wires = svg("svg", { class: "cv-wires", width: CV.W, height: CV.H, "aria-hidden": "true" });
  const temp = svg("path", { class: "cv-temp", d: "" });
  const viewport = h("div", { class: "cv-viewport" }, board);
  board.append(wires);
  CV.board = board;

  const count = h("span", { class: "small muted" });
  const toolbar = h("div", { class: "cv-toolbar" },
    h("div", { class: "grow" }, h("div", { class: "eyebrow" }, "Agentes · lienzo"), h("h1", { style: "margin:2px 0 0" }, "Lienzo de robots"),
      h("p", { class: "small muted", style: "margin:4px 0 0" }, "Arrastra los robots por el fondo. Tira del punto ● de un robot hasta un proyecto para conectarlo; pulsa un cable para quitarlo.")),
    count,
    h("button", { class: "btn", type: "button", onclick: () => pickDialog("a") }, icon("plus", 15), "Robot"),
    h("button", { class: "btn", type: "button", onclick: () => pickDialog("p") }, icon("plus", 15), "Proyecto"),
    h("button", { class: "btn ghost", type: "button", title: "Colocar en columnas", onclick: () => { autoLayout(); render(); cvSave(st); } }, icon("grid", 15), "Ordenar"));
  main.replaceChildren(h("div", { class: "cv" }, toolbar, viewport));

  const nodeKey = (n) => `${n.t}:${n.id}`;
  const els = new Map();
  const live = (pid) => (projects.get(pid)?.live || 0) > 0;
  const botState = (aid) => (st.links.some((l) => l.a === aid && live(l.p)) ? "running" : "idle");

  function autoLayout() {
    let ai = 0, pi = 0;
    for (const n of st.nodes) {
      if (n.t === "a") { n.x = 80 + (ai % 3) * 170; n.y = 50 + Math.floor(ai / 3) * 230; ai++; }
      else { n.x = 720; n.y = 40 + pi * 185; pi++; }
    }
  }

  function nodeEl(n) {
    const remove = h("button", { class: "cv-x", type: "button", "aria-label": "Quitar del lienzo", onpointerdown: (e) => e.stopPropagation(),
      onclick: () => { st.nodes = st.nodes.filter((x) => x !== n); st.links = st.links.filter((l) => (n.t === "a" ? l.a !== n.id : l.p !== n.id)); render(); cvSave(st); } }, "×");
    if (n.t === "a") {
      const a = agents.get(n.id);
      const links = st.links.filter((l) => l.a === a.id).length;
      return h("div", { class: "cv-node bot" + (botState(a.id) === "running" ? " live" : ""), "data-key": nodeKey(n), title: a.description },
        remove,
        h("div", { class: "cv-bot" }, agentRobot(a, botState(a.id), 74)),
        h("b", {}, a.name), h("small", {}, `${a.category_label}${links ? ` · ${links} proyecto${links === 1 ? "" : "s"}` : ""}`),
        h("span", { class: "cv-port out", "data-port": "a", title: "Arrastra hasta un proyecto" }));
    }
    const p = projects.get(n.id);
    const bots = st.links.filter((l) => l.p === p.id).map((l) => agents.get(l.a)).filter(Boolean);
    return h("div", { class: "cv-node proj" + (live(p.id) ? " live" : ""), "data-key": nodeKey(n) },
      remove,
      h("span", { class: "cv-port in", "data-port": "p", title: "Suelta aquí un robot" }),
      h("div", { class: `node-h col-${p.color || "azul"}` }, h("span", { class: "title" }, slug(p.name) + ".proj"), live(p.id) ? h("span", { class: "live-tag" }, "LIVE") : null),
      h("div", { class: "cv-proj-b" },
        h("div", { class: "cv-mini-bots" }, bots.length ? bots.slice(0, 6).map((a) => h("span", { title: a.name }, agentRobot(a, live(p.id) ? "running" : "idle", 22))) : h("span", { class: "small muted" }, "Sin robots conectados")),
        h("div", { class: "row", style: "gap:6px;margin-top:8px" },
          h("button", { class: "btn small primary", type: "button", disabled: bots.length ? null : true, onpointerdown: (e) => e.stopPropagation(), onclick: () => workWith(p, bots) }, icon("bolt", 14), bots.length ? `Trabajar con ${bots.length}` : "Trabajar"),
          h("a", { class: "btn small ghost", href: `#/p/${p.id}/overview`, onpointerdown: (e) => e.stopPropagation() }, "Abrir"))));
  }

  async function workWith(p, bots) {
    const ids = bots.filter((a) => !a.locked).map((a) => a.id).slice(0, reg.max_agents_per_message);
    if (bots.length > ids.length) toast(`Tu plan permite ${reg.max_agents_per_message} agentes por mensaje: se usan los primeros.`);
    const t = await api("POST", "/api/chat/threads", { project_id: p.id, title: `${p.name} · lienzo` });
    await api("PATCH", `/api/chat/threads/${t.id}`, { auto_mode: false, manual: { agents: ids, model: null, tools_off: [] } });
    location.hash = `#/chat/${t.id}`;
  }

  function portPos(key, kind) {
    const el = els.get(key);
    if (!el) return null;
    const port = el.querySelector(kind === "a" ? ".cv-port.out" : ".cv-port.in");
    const r = port.getBoundingClientRect(), b = board.getBoundingClientRect();
    return { x: r.left + r.width / 2 - b.left, y: r.top + r.height / 2 - b.top };
  }
  const curve = (a, b) => {
    const dx = Math.max(60, Math.abs(b.x - a.x) * 0.5);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  };

  function drawWires() {
    wires.replaceChildren(svg("defs", {}, svg("filter", { id: "cvglow", x: "-20%", y: "-20%", width: "140%", height: "140%" }, svg("feGaussianBlur", { stdDeviation: "4" }))));
    for (const l of st.links) {
      const a = portPos(`a:${l.a}`, "a"), b = portPos(`p:${l.p}`, "p");
      if (!a || !b) continue;
      const d = curve(a, b);
      const hot = live(l.p);
      const g = svg("g", { class: "cv-link" + (hot ? " hot" : ""), role: "button", "aria-label": "Quitar conexión" });
      if (hot) g.append(svg("path", { d, class: "cv-halo", filter: "url(#cvglow)" }));
      g.append(svg("path", { d, class: "cv-hit" }), svg("path", { d, class: "cv-line" }));
      if (hot && !REDUCED) {
        const id = `cvp${l.a.replace(/\W/g, "")}${l.p}`;
        g.append(svg("path", { id, d, fill: "none", stroke: "none" }));
        for (let i = 0; i < 3; i++) g.append(svg("circle", { r: 3, class: "cv-spark" }, svg("animateMotion", { dur: "1.8s", begin: `${-i * 0.6}s`, repeatCount: "indefinite" }, svg("mpath", { href: `#${id}` }))));
      }
      g.addEventListener("click", async () => {
        if (!(await confirmDialog({ title: "Quitar conexión", body: `¿Desconectar «${agents.get(l.a)?.name}» de «${projects.get(l.p)?.name}»?`, confirmLabel: "Quitar" }))) return;
        st.links = st.links.filter((x) => x !== l); render(); cvSave(st);
      });
      wires.append(g);
    }
    wires.append(temp);
  }

  function render() {
    [...board.querySelectorAll(".cv-node")].forEach((x) => x.remove());
    els.clear();
    for (const n of st.nodes) {
      const el = nodeEl(n);
      el.style.transform = `translate(${n.x}px, ${n.y}px)`;
      els.set(nodeKey(n), el);
      board.append(el);
      bindDrag(el, n);
    }
    count.textContent = `${st.nodes.filter((n) => n.t === "a").length} robots · ${st.nodes.filter((n) => n.t === "p").length} proyectos · ${st.links.length} conexiones`;
    requestAnimationFrame(drawWires);
  }

  // Arrastrar nodos y crear conexiones (ratón, lápiz y dedo).
  function bindDrag(el, n) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const port = e.target.closest(".cv-port");
      const b = board.getBoundingClientRect();
      if (port) {
        e.preventDefault();
        const from = port.dataset.port; // a: sale de un robot · p: sale de un proyecto
        const start = portPos(nodeKey(n), from);
        const move = (ev) => {
          const pt = { x: ev.clientX - b.left, y: ev.clientY - b.top };
          temp.setAttribute("d", from === "a" ? curve(start, pt) : curve(pt, start));
          board.querySelectorAll(".cv-node.drop").forEach((x) => x.classList.remove("drop"));
          document.elementFromPoint(ev.clientX, ev.clientY)?.closest(`.cv-node.${from === "a" ? "proj" : "bot"}`)?.classList.add("drop");
        };
        const up = (ev) => {
          window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
          temp.setAttribute("d", "");
          const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".cv-node");
          board.querySelectorAll(".cv-node.drop").forEach((x) => x.classList.remove("drop"));
          if (!target) return;
          const [t, id] = target.dataset.key.split(":");
          const link = from === "a" && t === "p" ? { a: n.id, p: Number(id) } : from === "p" && t === "a" ? { a: id, p: n.id } : null;
          if (!link) return;
          if (st.links.some((l) => l.a === link.a && l.p === link.p)) { toast("Ya estaban conectados"); return; }
          if (agents.get(link.a)?.locked) toast("Ese robot es PRO: se conecta, pero solo trabajará con Control IA Pro.");
          st.links.push(link); render(); cvSave(st);
          toast(`${agents.get(link.a)?.name} → ${projects.get(link.p)?.name}`);
        };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
        return;
      }
      if (e.target.closest("button, a")) return;
      e.preventDefault();
      el.classList.add("dragging");
      const ox = e.clientX - b.left - n.x, oy = e.clientY - b.top - n.y;
      const move = (ev) => {
        n.x = Math.max(0, Math.min(CV.W - 180, ev.clientX - b.left - ox));
        n.y = Math.max(0, Math.min(CV.H - 120, ev.clientY - b.top - oy));
        el.style.transform = `translate(${n.x}px, ${n.y}px)`;
        drawWires();
      };
      const up = () => {
        el.classList.remove("dragging");
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
        cvSave(st);
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    });
  }

  // Añadir robots o proyectos al lienzo.
  function pickDialog(t) {
    const q = h("input", { type: "search", placeholder: t === "a" ? "Buscar robot" : "Buscar proyecto" });
    const list = h("div", { class: "cv-pick" });
    const onBoard = new Set(st.nodes.filter((n) => n.t === t).map((n) => n.id));
    const items = t === "a" ? reg.agents : [...projects.values()];
    const renderList = () => list.replaceChildren(...items.filter((x) => !onBoard.has(x.id) && (!q.value || x.name.toLowerCase().includes(q.value.toLowerCase()))).map((x) =>
      h("button", { type: "button", class: "cv-pick-item", onclick: () => {
        const vp = viewport.getBoundingClientRect();
        st.nodes.push({ t, id: x.id, x: viewport.scrollLeft + vp.width / 2 - 90 + (Math.random() * 80 - 40), y: viewport.scrollTop + 60 + Math.random() * 80 });
        closeDialog(true); render(); cvSave(st);
      } }, t === "a" ? agentRobot(x, "idle", 34) : h("span", { class: `cv-dot col-${x.color || "azul"}` }),
        h("span", { class: "grow" }, h("b", {}, x.name), h("small", {}, t === "a" ? `${x.category_label}${x.locked ? " · PRO" : ""}` : `${(x.runs || 0) + (x.kairo_runs || 0)} tareas`)))));
    q.addEventListener("input", renderList);
    renderList();
    openDialog(t === "a" ? "Añadir robot al lienzo" : "Añadir proyecto al lienzo", [q, list], [h("button", { class: "btn", type: "button", onclick: () => closeDialog(false) }, "Cerrar")]);
    if (!items.some((x) => !onBoard.has(x.id))) list.replaceChildren(h("p", { class: "small muted" }, t === "a" ? "Ya están todos los robots en el lienzo." : "No hay más proyectos. Crea uno en Proyectos."));
  }

  render();
  // Estado vivo de los proyectos: los cables se encienden cuando trabajan.
  every(5000, async () => {
    if (!board.isConnected) return;
    const d = await api("GET", "/api/dashboard");
    const before = [...projects.values()].map((p) => p.live).join();
    projects = new Map(d.projects.map((p) => [p.id, p]));
    if (before !== d.projects.map((p) => p.live).join()) render();
  });
}
