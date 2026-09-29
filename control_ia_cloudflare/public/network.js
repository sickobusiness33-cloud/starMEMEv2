/* AI AGENT NETWORK — visualización de una ejecución real del orquestador.
 *
 * La red se genera a partir del estado real de la ejecución (chat_run_agents)
 * y de sus eventos (run_events). Nada es decorativo: cada nodo es un paso del
 * plan, cada conexión una dependencia real, y el estado visual refleja el
 * estado guardado en el servidor. Sin ejecución, la red muestra el estado IDLE.
 */
"use strict";

const ROLE_META = {
  ORCHESTRATOR: { label: "Orchestrator", icon: null },
  RESEARCHER: { label: "Researcher", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" },
  SCANNER: { label: "Scanner", icon: "M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 12l6-5M12 4v2M12 18v2" },
  ANALYST: { label: "Analyst", icon: "M5 19V11M10 19V5M15 19v-7M20 19V8" },
  CODER: { label: "Coder", icon: "M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12" },
  WRITER: { label: "Writer", icon: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4" },
  DESIGNER: { label: "Designer", icon: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4" },
  PLANNER: { label: "Planner", icon: "M5 12l3 3 6-7M5 5h6M5 19h14" },
  SECURITY: { label: "Security", icon: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" },
  ASSISTANT: { label: "Assistant", icon: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" },
  REVIEWER: { label: "Critic", icon: "M5 12l4 4 10-10M12 21a9 9 0 1 1 0-18" },
  RESULT: { label: "Result", icon: "M5 21V4h11l-2 4 2 4H5" },
};

/** Estado visual a partir del estado real del agente (sin inventar actividad). */
const VIS_STATE = {
  IDLE: "idle", QUEUED: "waiting", EXECUTING: "thinking", THINKING: "thinking", ANALYZING: "working", SEARCHING: "working",
  PROCESSING: "working", GENERATING: "working", COMPLETED: "completed", ERROR: "error",
};
const VIS_LABEL = { idle: "IDLE", thinking: "THINKING", planning: "PLANNING", working: "WORKING", waiting: "WAITING", reviewing: "REVIEWING", completed: "COMPLETED", error: "ERROR" };
const RUN_ACTIVE = new Set(["queued", "planning", "running", "aggregating", "validating"]);

function visOf(row) {
  const v = VIS_STATE[row.status] || "idle";
  if (row.role === "REVIEWER" && (v === "working" || v === "thinking")) return "reviewing";
  if (v === "working" && row.status === "ANALYZING") return "working";
  return v;
}

function stateLabel(row, vis) {
  if (vis === "working" && ["ANALYZING", "SEARCHING", "GENERATING"].includes(row.status)) return row.status;
  return VIS_LABEL[vis];
}

/** Glifo del agente según el estilo elegido en Ajustes (robot, orbe, hexágono). */
function agentGlyphSvg(role, size = 44) {
  const style = document.documentElement.dataset.robot || "bot";
  const meta = ROLE_META[role] || ROLE_META.ASSISTANT;
  const s = svg("svg", { class: `ag ag-${style}`, viewBox: "0 0 48 48", width: size, height: size, "aria-hidden": "true" });
  if (role === "ORCHESTRATOR") {
    s.append(svg("circle", { class: "ag-ring", cx: 24, cy: 24, r: 21 }));
    const logo = kairoLogo(30);
    logo.setAttribute("x", "9"); logo.setAttribute("y", "9");
    s.append(logo);
    return s;
  }
  if (style === "orb") {
    s.append(svg("circle", { class: "ag-ring", cx: 24, cy: 24, r: 21 }), svg("circle", { class: "ag-body", cx: 24, cy: 24, r: 15 }));
  } else if (style === "hex") {
    s.append(svg("path", { class: "ag-ring", d: "M24 3 42 13.5v21L24 45 6 34.5v-21Z" }), svg("path", { class: "ag-body", d: "M24 9 37 16.5v15L24 39 11 31.5v-15Z" }));
  } else {
    // Robot: cabeza con antena y ojos; el icono del rol va en el pecho.
    s.append(
      svg("circle", { class: "ag-ring", cx: 24, cy: 24, r: 22 }),
      svg("line", { class: "ag-line", x1: 24, y1: 6, x2: 24, y2: 11 }),
      svg("circle", { class: "ag-ant", cx: 24, cy: 5.5, r: 2.2 }),
      svg("rect", { class: "ag-body", x: 11, y: 11, width: 26, height: 26, rx: 8 }),
      svg("circle", { class: "ag-eye", cx: 19, cy: 19.5, r: 1.8 }),
      svg("circle", { class: "ag-eye", cx: 29, cy: 19.5, r: 1.8 }),
    );
  }
  const g = svg("g", { transform: style === "bot" ? "translate(16.5 22) scale(.62)" : "translate(15 15) scale(.75)" });
  g.append(svg("path", { class: "ag-icon", d: meta.icon }));
  s.append(g);
  return s;
}

/** Información de un agente del registro (nombre, color) o del orquestador/revisor. */
function agentInfo(row, agentsById) {
  if (row.agent_id === "kairo-reviewer") return { name: "Kairo Critic", role: "REVIEWER", description: "Revisa coherencia, contradicciones y que se responde a lo pedido." };
  const a = agentsById?.get(row.agent_id);
  return { name: a?.name || row.agent_id, role: row.role || a?.role || "ASSISTANT", description: a?.description || "", capabilities: a?.capabilities || [], tools: a?.tools || [], category_label: a?.category_label };
}

/** Construye el grafo (capas por dependencias) a partir del estado real. */
function buildGraph(state, agentsById) {
  const run = state?.run || null;
  const rows = state?.agents || [];
  const byStep = new Map(rows.map((r) => [r.step, r]));
  const depth = new Map();
  const depthOf = (r, seen = new Set()) => {
    if (depth.has(r.step)) return depth.get(r.step);
    if (seen.has(r.step)) return 1;
    seen.add(r.step);
    const deps = (r.depends_on || []).map((d) => byStep.get(d)).filter(Boolean);
    const d = deps.length ? 1 + Math.max(...deps.map((x) => depthOf(x, seen))) : 1;
    depth.set(r.step, d);
    return d;
  };
  rows.forEach((r) => depthOf(r));
  const runVis = !run ? "idle" : run.status === "failed" ? "error" : run.status === "completed" ? "completed"
    : run.status === "cancelled" ? "idle" : ["queued", "planning"].includes(run.status) ? "planning" : "working";
  const nodes = [{ id: "orch", kind: "orch", role: "ORCHESTRATOR", layer: 0, vis: runVis, name: `${BRAND_NAME} Orchestrator`,
    action: !run ? "Esperando una petición" : run.status === "planning" || run.status === "queued" ? "Analizando la petición y creando el plan" : run.reason || "Coordinando" }];
  for (const r of rows) {
    const info = agentInfo(r, agentsById);
    nodes.push({ id: r.step, kind: "agent", row: r, role: info.role, layer: depth.get(r.step) || 1, vis: visOf(r), name: info.name, action: r.action || "" });
  }
  const maxLayer = Math.max(0, ...nodes.map((n) => n.layer));
  const resultVis = !run ? "idle" : run.status === "completed" ? "completed" : run.status === "failed" ? "error" : run.status === "aggregating" ? "working" : "waiting";
  nodes.push({ id: "result", kind: "result", role: "RESULT", layer: maxLayer + 1, vis: resultVis, name: "Resultado",
    action: !run ? "" : run.status === "completed" ? "Entregado" : run.status === "aggregating" ? "Combinando resultados" : run.status === "failed" ? "No se pudo completar" : "Pendiente" });
  const edges = [];
  const agentRows = rows.filter((r) => r.step !== "review");
  const review = rows.find((r) => r.step === "review");
  const dependedOn = new Set(rows.flatMap((r) => r.depends_on || []));
  for (const r of agentRows) {
    if (!(r.depends_on || []).length) edges.push(["orch", r.step]);
    for (const d of r.depends_on || []) if (byStep.has(d)) edges.push([d, r.step]);
  }
  if (review) for (const d of review.depends_on || []) edges.push([d, "review"]);
  const sinks = agentRows.filter((r) => !dependedOn.has(r.step));
  if (review) edges.push(["review", "result"]);
  else if (sinks.length) sinks.forEach((r) => edges.push([r.step, "result"]));
  if (!rows.length) edges.push(["orch", "result"]);
  return { nodes, edges, run };
}

function nodeEl(n, opts) {
  const info = n.kind === "agent" ? agentInfo(n.row, opts.agentsById) : null;
  const r = n.row;
  const el = h("button", {
    type: "button", class: `net-node k-${n.kind} v-${n.vis}`, "data-id": n.id,
    "aria-label": `${n.name}: ${VIS_LABEL[n.vis]}${n.action ? `, ${n.action}` : ""}`,
    onclick: () => opts.onSelect?.(n),
  },
    h("span", { class: "net-glyph" }, agentGlyphSvg(n.role, opts.compact ? 36 : 44), n.vis === "completed" ? h("span", { class: "net-badge ok" }, "✓") : n.vis === "error" ? h("span", { class: "net-badge err" }, "!") : null),
    h("span", { class: "net-text" },
      h("span", { class: "net-role" }, (ROLE_META[n.role] || ROLE_META.ASSISTANT).label),
      h("span", { class: "net-name" }, n.name),
      h("span", { class: `net-state s-${n.vis}` }, n.kind === "agent" ? stateLabel(r, n.vis) : VIS_LABEL[n.vis]),
      n.action ? h("span", { class: "net-action" }, n.action) : null,
      r && (n.vis === "working" || n.vis === "thinking" || n.vis === "reviewing") ? h("span", { class: "net-progress" }, h("i", { style: `width:${Math.max(4, r.progress || 0)}%` })) : null,
      r && (r.model || r.execution_ms != null) ? h("span", { class: "net-tech" }, [r.model ? r.model.replace(/^@cf\//, "").split("/").pop() : null, r.execution_ms != null ? fmtMs(r.execution_ms) : null].filter(Boolean).join(" · ")) : null));
  if (info && info.description) el.title = info.description;
  return el;
}

/**
 * Pinta la red en `box`. opts: { agentsById, onSelect(node), compact, preview }.
 * Reutiliza el contenedor: solo recalcula posiciones y estados (render ligero).
 */
function renderNetwork(box, state, opts = {}) {
  const g = buildGraph(state, opts.agentsById);
  const W = Math.max(280, box.clientWidth || box.parentElement?.clientWidth || 640);
  const narrow = W < 560;
  const compact = opts.compact || narrow;
  const layers = [...new Set(g.nodes.map((n) => n.layer))].sort((a, b) => a - b);
  const rowH = compact ? 142 : 162;
  const H = layers.length * rowH + 24;
  const pos = new Map();
  for (const L of layers) {
    const inLayer = g.nodes.filter((n) => n.layer === L);
    inLayer.forEach((n, i) => pos.set(n.id, { x: (W / (inLayer.length + 1)) * (i + 1), y: 20 + L * rowH + rowH / 2 - 12 }));
  }
  const conn = document.documentElement.dataset.conn || "curve";
  const vis = new Map(g.nodes.map((n) => [n.id, n.vis]));
  const paths = g.edges.map(([a, b]) => {
    const p1 = pos.get(a), p2 = pos.get(b);
    if (!p1 || !p2) return null;
    const y1 = p1.y + (compact ? 26 : 32), y2 = p2.y - (compact ? 26 : 32);
    const d = conn === "straight" || conn === "dashed" ? `M${p1.x} ${y1} L${p2.x} ${y2}` : `M${p1.x} ${y1} C ${p1.x} ${(y1 + y2) / 2}, ${p2.x} ${(y1 + y2) / 2}, ${p2.x} ${y2}`;
    const va = vis.get(a), vb = vis.get(b);
    const state_ = va === "completed" && ["working", "thinking", "reviewing"].includes(vb) ? "active"
      : a === "orch" && ["working", "thinking", "waiting", "reviewing"].includes(vb) && RUN_ACTIVE.has(g.run?.status) ? "active"
      : va === "completed" && vb === "completed" ? "done" : va === "error" || vb === "error" ? "error" : "idle";
    return svg("path", { d, class: `net-edge e-${state_}${conn === "dashed" ? " dashed" : ""}` });
  }).filter(Boolean);
  const edgesSvg = svg("svg", { class: "net-edges", viewBox: `0 0 ${W} ${H}`, width: W, height: H, "aria-hidden": "true" }, ...paths);
  box.classList.toggle("compact", compact);
  box.style.height = `${H}px`;
  const nodes = g.nodes.map((n) => {
    const el = nodeEl(n, { ...opts, compact });
    const p = pos.get(n.id);
    el.style.cssText = `left:${p.x}px;top:${p.y}px`;
    return el;
  });
  box.replaceChildren(edgesSvg, ...nodes);
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", `Red de agentes: ${g.nodes.length - 2} agente(s)`);
  return g;
}

/* ------------------------------------------------------------- Mission Control */

function runProgress(state) {
  if (!state?.run) return 0;
  if (state.run.status === "completed") return 100;
  const rows = state.agents || [];
  if (!rows.length) return ["aggregating", "validating"].includes(state.run.status) ? 80 : state.run.status === "planning" ? 8 : 0;
  const agentPart = rows.reduce((a, r) => a + (r.status === "COMPLETED" || r.status === "ERROR" ? 100 : r.progress || 0), 0) / rows.length;
  return Math.round(Math.min(95, 10 + agentPart * 0.8 + (state.run.status === "aggregating" ? 5 : 0)));
}

function elapsedOf(run) {
  if (!run?.started_at && !run?.created_at) return 0;
  const start = new Date(run.started_at || run.created_at).getTime();
  const end = run.finished_at ? new Date(run.finished_at).getTime() : Date.now();
  return Math.max(0, end - start);
}
const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

const RUN_LABEL = { queued: "EN COLA", planning: "PLANIFICANDO", running: "WORKING", aggregating: "COMBINANDO", validating: "VALIDANDO", completed: "COMPLETADO", failed: "ERROR", cancelled: "CANCELADO" };

function missionControl(state, extra = {}) {
  const run = state?.run;
  const rows = state?.agents || [];
  const active = rows.filter((r) => ["working", "thinking", "reviewing"].includes(visOf(r))).length;
  const done = rows.filter((r) => r.status === "COMPLETED").length;
  const waiting = rows.filter((r) => r.status === "QUEUED").length;
  const lastEvent = (state?.events || []).at(-1);
  const live = run && RUN_ACTIVE.has(run.status);
  const pct = runProgress(state);
  const elapsed = h("b", { class: "mc-elapsed" }, run ? mmss(elapsedOf(run)) : "—");
  if (live) {
    const tid = setInterval(() => { if (!elapsed.isConnected) return clearInterval(tid); elapsed.textContent = mmss(elapsedOf(run)); }, 1000);
    S.timers.push(tid);
  }
  const status = !run ? "IDLE" : RUN_LABEL[run.status] || run.status.toUpperCase();
  return h("section", { class: `mission ${live ? "live" : ""}`, "aria-label": "Mission Control" },
    h("div", { class: "mc-cell mc-status" }, h("span", { class: "eyebrow" }, "Estado"), h("b", { class: `mc-dot s-${!run ? "idle" : live ? "working" : run.status === "failed" ? "error" : "completed"}` }, status),
      h("span", { class: "small muted" }, run ? `Tarea #${run.id}${run.task_type ? ` · ${run.task_type}` : ""}` : "Sin ejecuciones todavía")),
    h("div", { class: "mc-cell" }, h("span", { class: "eyebrow" }, "Progreso"), h("b", {}, `${pct}%`), h("span", { class: "mc-bar" }, h("i", { style: `width:${pct}%` }))),
    h("div", { class: "mc-cell" }, h("span", { class: "eyebrow" }, "Agentes"), h("b", {}, `${active} activos`), h("span", { class: "small muted" }, `${done} completados · ${waiting} esperando`)),
    h("div", { class: "mc-cell grow2" }, h("span", { class: "eyebrow" }, "Acción actual"), h("b", { class: "mc-action" }, live ? (lastEvent?.action || "Trabajando…") : run ? (lastEvent?.action || "—") : "Esperando una petición"),
      h("span", { class: "small muted" }, lastEvent ? `Última actividad ${hhmm(lastEvent.ts)}` : extra.objective ? `Resultado esperado: ${trunc(extra.objective, 80)}` : "")),
    h("div", { class: "mc-cell" }, h("span", { class: "eyebrow" }, "Tiempo"), elapsed, h("span", { class: "small muted" }, run?.finished_at ? "total" : live ? "transcurrido" : "")));
}

/* ------------------------------------------------------------- Timeline */

const EVENT_LABEL = {
  RUN_STARTED: "Petición recibida", PLAN_CREATED: "Plan creado", TASK_CREATED: "Tarea creada", TASK_STARTED: "Tarea iniciada", TASK_COMPLETED: "Tarea completada",
  TASK_FAILED: "Tarea fallida", AGENT_STARTED: "Agente iniciado", AGENT_WORKING: "Trabajando", AGENT_WAITING: "Esperando", AGENT_COMPLETED: "Completado",
  AGENT_ERROR: "Error", VALIDATION_STARTED: "Validación iniciada", VALIDATION_COMPLETED: "Validación completada", RUN_COMPLETED: "Resultado entregado",
  RUN_FAILED: "Ejecución fallida", RUN_CANCELLED: "Cancelada",
};
// En la línea de tiempo se omiten los eventos redundantes (TASK_* duplican a AGENT_*).
const TIMELINE_SKIP = new Set(["TASK_STARTED", "TASK_COMPLETED", "TASK_FAILED"]);

function eventWho(e, agentsById) {
  if (!e.agent_id) return { name: BRAND_NAME, role: "ORCHESTRATOR" };
  const info = agentInfo({ agent_id: e.agent_id, role: null }, agentsById);
  return { name: info.name, role: info.role };
}

function renderTimeline(box, events, opts = {}) {
  const list = events.filter((e) => !TIMELINE_SKIP.has(e.type) && (!opts.agent || e.agent_id === opts.agent));
  if (!list.length) { box.replaceChildren(h("p", { class: "small muted tl-empty" }, opts.emptyText || "Todavía no hay actividad registrada.")); return; }
  box.replaceChildren(...list.map((e) => {
    const who = eventWho(e, opts.agentsById);
    const kind = /ERROR|FAILED/.test(e.type) ? "error" : /COMPLETED/.test(e.type) ? "ok" : /WAITING/.test(e.type) ? "wait" : "info";
    const details = h("div", { class: "tl-details", hidden: true },
      h("div", {}, h("b", {}, "Evento: "), e.type), e.status ? h("div", {}, h("b", {}, "Estado: "), e.status) : null,
      e.progress != null ? h("div", {}, h("b", {}, "Progreso: "), `${e.progress}%`) : null,
      h("div", {}, h("b", {}, "Hora: "), fmtDate(e.ts)),
      e.data && Object.keys(e.data).length ? h("pre", { class: "tl-data" }, JSON.stringify(e.data, null, 1)) : null,
      opts.runLink && e.run_id ? h("a", { href: opts.runLink(e.run_id) }, "Ver tarea completa") : null);
    const row = h("li", { class: `tl-item k-${kind}`, "data-id": e.id },
      h("button", { type: "button", class: "tl-head", "aria-expanded": "false", onclick: (ev) => { details.hidden = !details.hidden; ev.currentTarget.setAttribute("aria-expanded", String(!details.hidden)); } },
        h("span", { class: "tl-time" }, e.ms != null && opts.relative !== false ? mmss(e.ms) : hhmm(e.ts)),
        h("span", { class: "tl-dot" }),
        h("span", { class: "tl-who" }, (ROLE_META[who.role] || ROLE_META.ASSISTANT).label.toUpperCase(), h("small", {}, who.name)),
        h("span", { class: "tl-what" }, e.action || EVENT_LABEL[e.type] || e.type)),
      details);
    return row;
  }));
}

/* ------------------------------------------------------------- Detalle del agente */

function openAgentDrawer(node, ctx = {}) {
  closeAgentDrawer();
  const r = node.row || {};
  const info = node.kind === "agent" ? agentInfo(r, ctx.agentsById) : { name: node.name, role: node.role, description: node.kind === "orch" ? "Analiza tu petición, crea el plan, elige agentes y modelos, coordina dependencias y combina los resultados." : "Respuesta final entregada al usuario." };
  const usage = ctx.usage?.get?.(r.agent_id);
  const close = h("button", { class: "icon-btn", type: "button", "aria-label": "Cerrar detalle" }, icon("close", 18));
  const vis = node.vis;
  const panel = h("aside", { class: "drawer", role: "dialog", "aria-label": `Detalle de ${info.name}` },
    h("div", { class: "drawer-head" },
      h("span", { class: `net-glyph v-${vis}` }, agentGlyphSvg(info.role, 52)),
      h("div", { class: "grow" }, h("div", { class: "eyebrow" }, (ROLE_META[info.role] || ROLE_META.ASSISTANT).label), h("h2", { class: "drawer-title" }, info.name),
        h("span", { class: `net-state s-${vis}` }, node.kind === "agent" ? stateLabel(r, vis) : VIS_LABEL[vis])),
      close),
    h("div", { class: "drawer-body stack" },
      info.description ? h("p", { class: "muted" }, info.description) : null,
      node.kind === "agent" ? h("div", { class: "kv-grid" },
        h("div", {}, h("span", {}, "Tarea"), h("b", {}, r.task || "—")),
        h("div", {}, h("span", {}, "Acción actual"), h("b", {}, r.action || "—")),
        h("div", {}, h("span", {}, "Progreso"), h("b", {}, `${r.status === "COMPLETED" ? 100 : r.progress || 0}%`)),
        h("div", {}, h("span", {}, "Tiempo"), h("b", {}, r.execution_ms != null ? fmtMs(r.execution_ms) : r.started_at ? mmss(Date.now() - new Date(r.started_at).getTime()) : "—")),
        h("div", { class: "tech" }, h("span", {}, "Modelo / proveedor"), h("b", {}, r.model ? `${r.model.replace(/^@cf\//, "")}${r.provider ? ` · ${PROVIDER_LABEL[r.provider] || r.provider}` : ""}${r.fallback ? " · fallback" : ""}` : "—")),
        r.confidence != null ? h("div", {}, h("span", {}, "Confianza (heurística)"), h("b", {}, `${Math.round(r.confidence * 100)}%`)) : null,
        usage ? h("div", {}, h("span", {}, "En este proyecto"), h("b", {}, `${usage.done || 0} completadas · ${Math.max(0, (usage.tasks || 0) - (usage.done || 0) - (usage.errors || 0))} pendientes`)) : null,
        info.tools?.length ? h("div", {}, h("span", {}, "Herramientas"), h("b", {}, info.tools.join(", "))) : null) : null,
      r.why ? h("details", { class: "why", open: true }, h("summary", {}, "¿Por qué este agente?"), h("p", {}, r.why)) : null,
      r.status === "ERROR" ? h("div", { class: "alert small" }, r.action || "Error") : null,
      r.result ? h("details", { class: "result" }, h("summary", {}, "Resultado generado"), md(r.result)) : null,
      ctx.onViewActivity ? h("button", { class: "btn", type: "button", onclick: () => { closeAgentDrawer(); ctx.onViewActivity(r.agent_id || null); } }, icon("activity", 15), "View activity") : null));
  const backdrop = h("div", { class: "drawer-backdrop", onclick: closeAgentDrawer });
  close.addEventListener("click", closeAgentDrawer);
  const onKey = (e) => { if (e.key === "Escape") closeAgentDrawer(); };
  document.addEventListener("keydown", onKey);
  panel._cleanup = () => document.removeEventListener("keydown", onKey);
  document.body.append(backdrop, panel);
  close.focus();
}

function closeAgentDrawer() {
  document.querySelectorAll(".drawer").forEach((d) => { d._cleanup?.(); d.remove(); });
  document.querySelectorAll(".drawer-backdrop").forEach((d) => d.remove());
}

/* ------------------------------------------------------------- Replay */

/**
 * Reproduce una ejecución terminada a partir de sus eventos guardados.
 * Los huecos largos se comprimen (máx. 1,2 s) para que el replay sea ágil;
 * el orden y los estados son exactamente los registrados.
 */
function mountReplay(box, data, ctx = {}) {
  const events = data.events || [];
  const byStep = new Map((data.agents || []).map((a) => [a.step, a]));
  const netBox = h("div", { class: "net-wrap" });
  const tl = h("ol", { class: "timeline-list" });
  const bar = h("input", { type: "range", min: 0, max: Math.max(0, events.length), value: 0, "aria-label": "Posición del replay" });
  const playBtn = h("button", { class: "btn primary small", type: "button" }, icon("play", 15), "Play");
  const speedSel = h("select", { "aria-label": "Velocidad" }, h("option", { value: "1" }, "1×"), h("option", { value: "2" }, "2×"), h("option", { value: "4" }, "4×"));
  const counter = h("span", { class: "small muted" });
  let idx = 0, timer = null, playing = false;

  const stateAt = (n) => {
    const st = { run: { ...data.run, status: "queued", finished_at: null }, agents: [], events: [] };
    const agents = new Map();
    for (const e of events.slice(0, n)) {
      st.events.push(e);
      if (e.type === "RUN_STARTED") st.run.status = "planning";
      if (e.type === "PLAN_CREATED") st.run.status = "running";
      if (e.step && !agents.has(e.step) && byStep.has(e.step)) agents.set(e.step, { ...byStep.get(e.step), status: "QUEUED", action: "", progress: 0, execution_ms: null, model: null, result: null });
      const a = e.step ? agents.get(e.step) : null;
      if (a && e.type.startsWith("AGENT_")) {
        a.status = e.status || a.status;
        if (e.action) a.action = e.action;
        if (e.progress != null) a.progress = e.progress;
        if (e.type === "AGENT_COMPLETED") { a.progress = 100; const f = byStep.get(e.step); Object.assign(a, { model: f.model, execution_ms: f.execution_ms, result: f.result, confidence: f.confidence }); }
      }
      if (e.type === "VALIDATION_STARTED") st.run.status = "validating";
      if (e.type === "RUN_COMPLETED") { st.run.status = "completed"; st.run.finished_at = data.run.finished_at; }
      if (e.type === "RUN_FAILED") st.run.status = "failed";
      if (e.type === "RUN_CANCELLED") st.run.status = "cancelled";
    }
    if (st.run.status === "running" && [...agents.values()].every((a) => a.status === "COMPLETED") && agents.size) st.run.status = "aggregating";
    st.agents = [...agents.values()];
    return st;
  };
  const draw = () => {
    const st = stateAt(idx);
    renderNetwork(netBox, st, { agentsById: ctx.agentsById, onSelect: (n) => openAgentDrawer(n, ctx) });
    renderTimeline(tl, st.events, { agentsById: ctx.agentsById });
    tl.lastElementChild?.classList.add("current");
    bar.value = idx;
    counter.textContent = `${idx}/${events.length} eventos${events[idx - 1] ? ` · ${mmss(events[idx - 1].ms)}` : ""}`;
  };
  const stop = () => { playing = false; clearTimeout(timer); playBtn.replaceChildren(icon("play", 15), idx >= events.length ? "Replay" : "Play"); };
  const step = () => {
    if (!playing) return;
    if (idx >= events.length) return stop();
    idx++;
    draw();
    const gap = events[idx] ? Math.min(1200, Math.max(120, events[idx].ms - events[idx - 1].ms)) : 0;
    timer = setTimeout(step, gap / Number(speedSel.value));
  };
  playBtn.addEventListener("click", () => {
    if (playing) return stop();
    if (idx >= events.length) idx = 0;
    playing = true; playBtn.replaceChildren(icon("pause", 15), "Pausa"); step();
  });
  bar.addEventListener("input", () => { stop(); idx = Number(bar.value); draw(); });
  S.cleanups.push(stop);
  box.replaceChildren(
    h("div", { class: "replay-bar" }, playBtn, h("button", { class: "btn ghost small", type: "button", onclick: () => { stop(); idx = 0; draw(); } }, icon("refresh", 15), "Reiniciar"), speedSel, h("div", { class: "grow" }, bar), counter),
    h("div", { class: "replay-grid" }, h("div", { class: "card net-card" }, netBox), h("div", { class: "card" }, h("div", { class: "card-h" }, "Execution replay"), h("div", { class: "card-b" }, tl))));
  if (!events.length) box.append(h("p", { class: "small muted" }, "Esta ejecución no tiene eventos guardados (es anterior al registro de eventos)."));
  draw();
}
