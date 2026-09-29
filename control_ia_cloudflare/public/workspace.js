/* PROJECT WORKSPACE — cada proyecto es un centro de operaciones:
 * Overview · AI Workspace · Agents · Tasks · Activity · Files · Memory · Analytics · Settings.
 *
 * Tiempo real: un único stream SSE por proyecto (/api/workspace/projects/:id/stream)
 * alimenta Mission Control, la red de agentes y la actividad.
 */
"use strict";

const WS_TABS = [
  ["overview", "Overview", "grid"], ["workspace", "AI Workspace", "kairo"], ["agents", "Agents", "agents"], ["tasks", "Tasks", "check"],
  ["activity", "Activity", "activity"], ["files", "Files", "projects"], ["memory", "Memory", "memory"], ["analytics", "Analytics", "panel"], ["settings", "Settings", "settings"],
];
const MEMORY_KIND = { objective: "Objetivo", instruction: "Instrucción", preference: "Preferencia", decision: "Decisión", fact: "Dato" };
const TPL_ICON = { software: "coding", marketing: "marketing", research: "research", content: "writing", business: "business", data: "data", automation: "automation", assistant: "productivity", custom: "general" };

/* ================================================================ LISTA DE PROYECTOS */

async function viewProjectsOS(main) {
  const state = { q: "", status: "active" };
  const grid = h("div", { class: "proj-grid" });
  const search = h("input", { type: "search", placeholder: "Buscar proyectos", "aria-label": "Buscar proyectos" });
  let tmr = null;
  search.addEventListener("input", () => { clearTimeout(tmr); tmr = setTimeout(() => { state.q = search.value.trim(); load(); }, 200); });
  const statusSel = h("div", { class: "segctl" });
  const renderStatus = () => statusSel.replaceChildren(...[["active", "Activos"], ["archived", "Archivados"]].map(([id, l]) =>
    h("button", { type: "button", "aria-selected": state.status === id ? "true" : "false", onclick: () => { state.status = id; renderStatus(); load(); } }, l)));
  renderStatus();
  const load = async () => {
    const rows = await api("GET", `/api/projects?status=${state.status}&q=${encodeURIComponent(state.q)}`);
    S.projects = rows;
    grid.replaceChildren(
      state.status === "active" && !state.q ? h("button", { class: "proj-card new", type: "button", onclick: newProjectOS },
        h("span", { class: "proj-new-ico" }, icon("plus", 26)), h("b", {}, "Nuevo proyecto"), h("span", { class: "small muted" }, "Solo nombre y objetivo. Kairo se encarga del resto.")) : null,
      ...rows.map((p, i) => projectCard(p, i)));
    if (!rows.length && (state.q || state.status !== "active")) grid.append(h("div", { class: "card" }, empty("Sin resultados", state.q ? "Ningún proyecto coincide." : "No hay proyectos archivados.")));
  };
  main.replaceChildren(h("div", { class: "stack" },
    h("div", { class: "page-head" }, h("div", {}, h("div", { class: "eyebrow" }, "Projects"), h("h1", {}, "Proyectos"),
      h("p", { class: "muted" }, "Cada proyecto es un espacio de trabajo con memoria, agentes, tareas y actividad propios.")),
      h("button", { class: "btn primary", type: "button", onclick: newProjectOS }, icon("plus", 16), "Nuevo proyecto")),
    h("div", { class: "row" }, h("div", { class: "grow" }, search), statusSel),
    grid));
  await load();
}

function projectCard(p, i) {
  const working = p.task_active > 0;
  return h("a", { class: "proj-card" + (working ? " working" : ""), href: `#/p/${p.id}/overview`, style: `--k:${Math.min(i, 12)};--c:${COLOR_HEX[p.color] || "var(--th-primary)"}` },
    h("div", { class: "proj-top" },
      h("span", { class: "proj-ico" }, icon(TPL_ICON[p.template] ? "agents" : "projects", 18)),
      h("span", { class: `status-chip s-${working ? "working" : "idle"}` }, working ? "WORKING" : "IDLE")),
    h("h3", { class: "proj-name" }, p.name),
    h("p", { class: "proj-obj" }, trunc(p.objective || p.description || "Sin objetivo definido", 140)),
    h("div", { class: "proj-meta" },
      h("span", {}, h("b", {}, p.task_count), " tareas"), h("span", {}, h("b", {}, p.task_completed), " completadas"), h("span", {}, h("b", {}, p.file_count), " archivos"),
      h("span", { class: "grow ta-r" }, p.last_task_at ? `Actividad ${fmtDate(p.last_task_at)}` : `Creado ${fmtDate(p.created_at)}`)));
}

async function newProjectOS() {
  const templates = await api("GET", "/api/workspace/templates");
  let chosen = "custom";
  const name = h("input", { type: "text", required: true, maxlength: 80, placeholder: "Mi web de recetas", id: "np-name" });
  const objective = h("textarea", { rows: 3, maxlength: 1000, placeholder: "¿Qué quieres conseguir? Ej.: Lanzar una web de recetas saludables con blog y newsletter.", id: "np-obj" });
  const grid = h("div", { class: "tpl-grid", role: "radiogroup", "aria-label": "Plantilla (opcional)" });
  const render = () => grid.replaceChildren(...templates.map((t) => h("button", { type: "button", role: "radio", class: "tpl", "aria-checked": chosen === t.id ? "true" : "false",
    onclick: () => { chosen = t.id; if (!objective.value.trim() && t.objective) objective.placeholder = t.objective; render(); } },
    icon(TPL_ICON[t.id] === "general" ? "spark" : "agents", 16), h("span", {}, t.label))));
  render();
  const res = await formDialog({
    title: "Nuevo proyecto",
    intro: h("p", { class: "small muted" }, "No hace falta elegir modelo, proveedor ni agentes: Kairo lo decide en cada tarea. La plantilla es opcional."),
    fields: [field("Nombre", name), field("Objetivo", objective, "Kairo lo usará como contexto en todas las tareas."), h("div", { class: "field" }, h("label", {}, "Plantilla (opcional)"), grid)],
    submitLabel: "Crear y entrar",
    onSubmit: async () => api("POST", "/api/projects", { name: name.value.trim(), objective: objective.value.trim() || undefined, template: chosen }),
  });
  if (res && res.id) { toast("Proyecto creado"); location.hash = `#/p/${res.id}/overview`; }
}

/* ================================================================ ESPACIO DE TRABAJO */

async function viewWorkspace(main) {
  const parts = hashParts();
  const pid = Number(parts[1]);
  const tab = WS_TABS.some(([id]) => id === parts[2]) ? parts[2] : "overview";
  let ov;
  try { ov = await api("GET", `/api/workspace/projects/${pid}`); }
  catch (err) { main.replaceChildren(h("div", { class: "card" }, empty("Proyecto no encontrado", err.message, h("a", { class: "btn", href: "#/proyectos" }, "Volver a proyectos")))); return; }
  const reg = await api("GET", "/api/chat/agents");
  const agentsById = new Map(reg.agents.map((a) => [a.id, a]));
  const p = ov.project;
  const WS = { pid, ov, reg, agentsById, state: ov.latest, listeners: new Set() };

  // --- stream en tiempo real del proyecto
  if (window.EventSource) {
    const es = new EventSource(`/api/workspace/projects/${pid}/stream`);
    es.addEventListener("state", (ev) => { WS.state = JSON.parse(ev.data); WS.listeners.forEach((fn) => fn(WS.state)); });
    S.cleanups.push(() => es.close());
  }

  const statusChip = h("span", { class: "status-chip" });
  const setStatus = (st) => {
    const live = st?.run && RUN_ACTIVE.has(st.run.status);
    statusChip.className = `status-chip s-${live ? "working" : st?.run?.status === "failed" ? "error" : "idle"}`;
    statusChip.textContent = live ? "● WORKING" : st?.run?.status === "failed" ? "ERROR" : "IDLE";
  };
  setStatus(WS.state);
  WS.listeners.add(setStatus);

  const view = PREFS.data.workspace?.view || "live";
  const viewToggle = h("div", { class: "segctl small", role: "tablist", "aria-label": "Vista" },
    ...[["live", "Live"], ["minimal", "Minimal"]].map(([id, l]) => h("button", { type: "button", "aria-selected": view === id ? "true" : "false",
      onclick: () => { setPrefs({ workspace: { view: id } }); route(); } }, l)));
  const animBtn = h("button", { class: "btn small ghost", type: "button", "aria-pressed": document.documentElement.dataset.anim !== "off" ? "true" : "false",
    onclick: () => { setPrefs({ visuals: { anim: document.documentElement.dataset.anim === "off" ? "normal" : "off" } }); route(); } },
    icon("bolt", 14), document.documentElement.dataset.anim === "off" ? "Animaciones: off" : "Animaciones: on");

  const header = h("header", { class: "ws-head" },
    h("a", { class: "ws-back", href: "#/proyectos" }, icon("back", 16), "Projects"),
    h("div", { class: "ws-title-row" },
      h("div", { class: "grow" }, h("div", { class: "eyebrow" }, "Project workspace"), h("h1", { class: "ws-title" }, p.name),
        h("p", { class: "ws-obj" }, p.objective || "Sin objetivo: añádelo en Settings o en Memory para dar contexto a Kairo.")),
      h("div", { class: "ws-head-actions" }, statusChip, viewToggle, animBtn)));
  const subnav = h("nav", { class: "ws-nav", "aria-label": "Secciones del proyecto" },
    WS_TABS.map(([id, label, ic]) => h("a", { href: `#/p/${pid}/${id}`, "aria-current": tab === id ? "page" : null }, icon(ic, 15), label)));
  const body = h("div", { class: "ws-body" });
  main.replaceChildren(h("div", { class: "ws" }, header, subnav, body));
  const tabs = { overview: wsOverview, workspace: wsAIWorkspace, agents: wsAgents, tasks: wsTasks, activity: wsActivity, files: wsFiles, memory: wsMemory, analytics: wsAnalytics, settings: wsSettings };
  await tabs[tab](body, WS, parts);
}

/** Tarjeta con la red de agentes en vivo (se actualiza con el stream). */
function liveNetworkCard(WS, { title = "AI Agent Network", compact = false } = {}) {
  const netBox = h("div", { class: "net-wrap" });
  const sub = h("span", { class: "small muted" });
  const card = h("section", { class: "card net-card" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, title), sub), h("div", { class: "card-b" }, netBox));
  const usage = null;
  const draw = (st) => {
    if (!netBox.isConnected) return;
    renderNetwork(netBox, st, { agentsById: WS.agentsById, compact, onSelect: (n) => openAgentDrawer(n, { agentsById: WS.agentsById, usage, onViewActivity: (aid) => { location.hash = `#/p/${WS.pid}/activity${aid ? `?agent=${aid}` : ""}`; } }) });
    sub.textContent = st?.run ? `Tarea #${st.run.id} · ${st.run.planner === "llm" ? "plan por IA" : st.run.planner === "rules" ? "plan por reglas" : st.run.planner || ""}` : "Sin ejecuciones: envía una petición en AI Workspace";
  };
  requestAnimationFrame(() => draw(WS.state));
  WS.listeners.add(draw);
  const onResize = () => draw(WS.state);
  window.addEventListener("resize", onResize);
  S.cleanups.push(() => window.removeEventListener("resize", onResize));
  return card;
}

function liveMission(WS) {
  const box = h("div", {});
  const draw = (st) => { if (box.isConnected || !box.parentElement) box.replaceChildren(missionControl(st, { objective: WS.ov.project.objective })); };
  draw(WS.state);
  WS.listeners.add(draw);
  return box;
}

/* ---------------------------------------------------------------- Overview */

async function wsOverview(body, WS) {
  const { ov } = WS;
  const s = ov.stats;
  const minimal = PREFS.data.workspace?.view === "minimal";
  const tl = h("ol", { class: "timeline-list" });
  renderTimeline(tl, ov.events, { agentsById: WS.agentsById, relative: false, runLink: (id) => `#/p/${WS.pid}/tasks/${id}`, emptyText: "Aún no hay actividad. Envía tu primera petición en AI Workspace." });
  const stat = (label, value, hint) => h("div", { class: "stat" }, h("span", { class: "eyebrow" }, label), h("b", {}, value), hint ? h("span", { class: "small muted" }, hint) : null);
  body.replaceChildren(h("div", { class: "stack" },
    liveMission(WS),
    h("div", { class: "ov-grid" },
      h("div", { class: "stack" },
        minimal ? null : liveNetworkCard(WS),
        h("section", { class: "card" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, "Último resultado"),
          ov.last_result ? h("a", { class: "btn small ghost", href: `#/p/${WS.pid}/tasks/${ov.last_result.run_id}` }, "Ver tarea") : null),
          h("div", { class: "card-b" }, ov.last_result ? h("div", { class: "result-preview" }, md(trunc(ov.last_result.content, 1600))) : empty("Sin resultados todavía", "Pide algo a Kairo y el resultado aparecerá aquí.",
            h("a", { class: "btn primary", href: `#/p/${WS.pid}/workspace` }, icon("kairo", 16), "Abrir AI Workspace"))))),
      h("div", { class: "stack" },
        h("div", { class: "stat-grid" },
          stat("Tareas", s.runs, `${s.completed} completadas · ${s.failed} fallidas`),
          stat("Subtareas de agentes", s.tasks, `${s.tasks_done} completadas`),
          stat("Agentes usados", s.agents_used), stat("Tiempo medio", s.avg_ms != null ? fmtMs(s.avg_ms) : "—")),
        h("section", { class: "card" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, "Actividad reciente"), h("a", { class: "btn small ghost", href: `#/p/${WS.pid}/activity` }, "Todo")), h("div", { class: "card-b" }, tl)),
        h("section", { class: "card" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, "Memoria del proyecto"), h("a", { class: "btn small ghost", href: `#/p/${WS.pid}/memory` }, "Gestionar")),
          h("div", { class: "card-b" }, ov.memory.length ? h("ul", { class: "mem-mini" }, ov.memory.filter((m) => m.pinned).slice(0, 6).map((m) => h("li", {}, h("span", { class: "mem-kind" }, MEMORY_KIND[m.kind] || m.kind), m.content)))
            : h("p", { class: "small muted" }, "Añade objetivos, preferencias y decisiones: Kairo los tendrá en cuenta en cada tarea."))),
        h("div", { class: "quick-links" },
          h("a", { class: "btn primary", href: `#/p/${WS.pid}/workspace` }, icon("kairo", 16), "AI Workspace"),
          h("a", { class: "btn", href: `#/p/${WS.pid}/files` }, icon("projects", 15), `Files · ${s.files}`),
          h("a", { class: "btn", href: `#/p/${WS.pid}/analytics` }, icon("panel", 15), "Analytics"))))));
}

/* ---------------------------------------------------------------- AI Workspace (chat + red) */

async function wsAIWorkspace(body, WS, parts) {
  const threads = await api("GET", `/api/chat/threads?project_id=${WS.pid}`);
  let threadId = Number(new URLSearchParams(location.hash.split("?")[1] || "").get("t")) || threads[0]?.id || null;
  const minimal = PREFS.data.workspace?.view === "minimal";
  const list = h("div", { class: "ws-threads" },
    h("button", { class: "btn small", type: "button", onclick: async () => {
      const t = await api("POST", "/api/chat/threads", { project_id: WS.pid });
      location.hash = `#/p/${WS.pid}/workspace?t=${t.id}`;
    } }, icon("plus", 14), "Nueva conversación"),
    ...threads.map((t) => h("a", { class: "ws-thread", href: `#/p/${WS.pid}/workspace?t=${t.id}`, "aria-current": t.id === threadId ? "true" : null }, trunc(t.title, 38))));
  const msgs = h("div", { class: "kx-msgs", "aria-live": "polite" });
  const input = h("textarea", { rows: 1, placeholder: "Describe lo que quieres conseguir en este proyecto…", "aria-label": "Petición para el proyecto" });
  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(200, input.scrollHeight) + "px"; };
  input.addEventListener("input", autosize);
  const sendBtn = h("button", { class: "kx-send", type: "submit", "aria-label": "Enviar" }, icon("send", 18));
  const stopBtn = h("button", { class: "kx-send stop", type: "button", "aria-label": "Detener", hidden: true }, icon("stop", 16));
  let attached = [];
  const chips = h("div", { class: "att-chips" });
  const picker = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
  picker.addEventListener("change", async () => {
    for (const f of [...picker.files].slice(0, 4 - attached.length)) {
      try { const up = await uploadImage(f); attached.push({ id: up.id, name: f.name }); } catch (err) { toast(err.message, true); }
    }
    picker.value = "";
    chips.replaceChildren(...attached.map((a, i) => h("span", { class: "att-chip" }, h("img", { class: "att-thumb", src: imgUrl(a.id), alt: "" }), trunc(a.name, 18),
      h("button", { class: "att-x", type: "button", "aria-label": "Quitar", onclick: () => { attached.splice(i, 1); picker.dispatchEvent(new Event("change")); } }, "×"))));
  });
  const form = h("form", { class: "kx-composer" }, chips, h("div", { class: "kx-compose-row" },
    h("button", { class: "kx-attach", type: "button", "aria-label": "Adjuntar imagen", onclick: () => picker.click() }, icon("clip", 18)), input, sendBtn, stopBtn), picker);
  const saveMem = (m) => memoryDialog(WS.pid, { kind: "decision", content: trunc(m.content, 1000), source: "kairo" });
  const msgNode = (m) => {
    const n = kairoMessage(m, WS.agentsById);
    if (m.role === "assistant") n.querySelector(".kx-actions")?.append(h("button", { class: "kx-act", type: "button", title: "Guardar en memoria", "aria-label": "Guardar en memoria del proyecto", onclick: () => saveMem(m) }, icon("memory", 15)));
    return n;
  };
  const scroll = () => { msgs.scrollTop = msgs.scrollHeight; };
  let pendingRun = null, liveNode = null;
  const renderMessages = async () => {
    if (!threadId) { msgs.replaceChildren(h("div", { class: "kx-empty" }, kairoAvatar("idle", 52), h("p", {}, "Escribe tu petición. Kairo usará el objetivo, la memoria y los archivos del proyecto, elegirá los agentes y verás cómo trabajan."))); return; }
    const t = await api("GET", `/api/chat/threads/${threadId}`);
    msgs.replaceChildren(...(t.messages.length ? t.messages.map(msgNode) : [h("div", { class: "kx-empty" }, kairoAvatar("idle", 52), h("p", {}, "Conversación vacía."))]));
    if (t.active_run_id) { pendingRun = t.active_run_id; stopBtn.hidden = false; sendBtn.hidden = true; }
    scroll();
  };
  // Resultado de la ejecución en curso: llega por el stream del proyecto.
  const onState = (st) => {
    if (!pendingRun || !st?.run || st.run.id !== pendingRun) return;
    if (!liveNode) { liveNode = kairoWorking(); msgs.append(liveNode); scroll(); }
    updateWorking(liveNode, st, WS.agentsById);
    if (!RUN_ACTIVE.has(st.run.status)) {
      const node = st.message ? msgNode(st.message) : h("div", { class: "kx-msg assistant error" }, h("div", { class: "kx-bubble" }, st.run.status === "cancelled" ? "Petición cancelada." : st.run.error || "No se pudo completar."));
      liveNode.replaceWith(node); liveNode = null; pendingRun = null;
      stopBtn.hidden = true; sendBtn.hidden = false; scroll();
    }
  };
  WS.listeners.add(onState);
  stopBtn.addEventListener("click", () => pendingRun && api("POST", `/api/chat/runs/${pendingRun}/cancel`).catch((e) => toast(e.message, true)));
  const send = async () => {
    const content = input.value.trim();
    if (!content || pendingRun) return;
    msgs.querySelector(".kx-empty")?.remove();
    msgs.append(msgNode({ role: "user", content, images: attached.map((a) => a.id) })); scroll();
    const ids = attached.map((a) => a.id); attached = []; chips.replaceChildren();
    input.value = ""; autosize();
    try {
      if (!threadId) { threadId = (await api("POST", "/api/chat/threads", { project_id: WS.pid })).id; history.replaceState(null, "", `#/p/${WS.pid}/workspace?t=${threadId}`); }
      const res = await api("POST", `/api/chat/threads/${threadId}/messages`, { content, image_ids: ids });
      pendingRun = res.run.id; stopBtn.hidden = false; sendBtn.hidden = true;
      onState(WS.state);
    } catch (err) {
      msgs.append(h("div", { class: "kx-msg assistant error" }, h("div", { class: "kx-bubble" }, err.message))); input.value = content;
    }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  const tl = h("ol", { class: "timeline-list" });
  const drawTl = (st) => renderTimeline(tl, st?.events || [], { agentsById: WS.agentsById, emptyText: "La actividad de la tarea en curso aparecerá aquí." });
  drawTl(WS.state);
  WS.listeners.add(drawTl);
  body.replaceChildren(h("div", { class: "aiw" + (minimal ? " minimal" : "") },
    h("aside", { class: "aiw-side" }, h("div", { class: "eyebrow" }, "Conversaciones"), list,
      h("p", { class: "small muted" }, "El historial de chat es solo una parte del proyecto: la memoria, tareas y archivos están en sus secciones.")),
    h("section", { class: "card aiw-chat" }, msgs, form),
    h("aside", { class: "aiw-live stack" }, liveMission(WS), minimal ? null : liveNetworkCard(WS, { title: "Live network", compact: true }),
      minimal ? null : h("section", { class: "card" }, h("div", { class: "card-h" }, "Live activity"), h("div", { class: "card-b" }, tl)))));
  await renderMessages();
  input.focus();
}

/* ---------------------------------------------------------------- Agents */

async function wsAgents(body, WS) {
  const data = await api("GET", `/api/workspace/projects/${WS.pid}/agents`);
  const usage = new Map(data.agents.map((a) => [a.id, a.usage]));
  const card = (a) => {
    const active = a.usage.active > 0;
    const node = { kind: "agent", role: a.role, vis: active ? "working" : a.usage.tasks ? "completed" : "idle", name: a.name, row: { agent_id: a.id, role: a.role, status: active ? "PROCESSING" : "IDLE", why: `Kairo lo elige automáticamente cuando la tarea necesita: ${a.capabilities.slice(0, 3).join(", ")}.` } };
    return h("button", { type: "button", class: `agent-tile v-${node.vis}${a.locked ? " locked" : ""}`, onclick: () => openAgentDrawer(node, { agentsById: WS.agentsById, usage, onViewActivity: (aid) => { location.hash = `#/p/${WS.pid}/activity?agent=${aid}`; } }) },
      h("span", { class: `net-glyph v-${node.vis}` }, agentGlyphSvg(a.role, 38)),
      h("span", { class: "grow" }, h("b", {}, a.name), h("small", {}, `${ROLE_META[a.role]?.label || a.role} · ${a.category_label}`),
        h("span", { class: "tile-meta" }, a.usage.tasks ? `${a.usage.done}/${a.usage.tasks} tareas · ${a.usage.avg_ms != null ? fmtMs(a.usage.avg_ms) : "—"}` : a.locked ? "PRO" : "Disponible")),
      h("span", { class: `dot s-${node.vis}` }));
  };
  const active = data.agents.filter((a) => a.usage.active > 0);
  const used = data.agents.filter((a) => a.usage.tasks > 0 && !a.usage.active);
  const rest = data.agents.filter((a) => !a.usage.tasks);
  body.replaceChildren(h("div", { class: "stack" },
    h("div", { class: "info small" }, "No tienes que activar agentes: todos están disponibles y Kairo decide cuáles usar en cada tarea. Aquí ves su estado y uso real en este proyecto."),
    h("h2", {}, `Active · ${active.length}`), active.length ? h("div", { class: "tile-grid" }, active.map(card)) : h("p", { class: "small muted" }, "Ningún agente trabajando ahora mismo."),
    h("h2", {}, `Usados en este proyecto · ${used.length}${data.reviewer ? " + Critic" : ""}`), used.length ? h("div", { class: "tile-grid" }, used.map(card)) : h("p", { class: "small muted" }, "Aún no se ha usado ninguno."),
    h("h2", {}, `Available · ${rest.length}`), h("div", { class: "tile-grid" }, rest.map(card))));
}

/* ---------------------------------------------------------------- Tasks (+ Task Graph + Replay) */

async function wsTasks(body, WS, parts) {
  const runs = await api("GET", `/api/workspace/projects/${WS.pid}/runs`);
  const selected = Number(parts[3]) || runs[0]?.id || null;
  const list = h("div", { class: "task-list" }, runs.length ? runs.map((r) => h("a", { class: "task-row", href: `#/p/${WS.pid}/tasks/${r.id}`, "aria-current": r.id === selected ? "true" : null },
    h("span", { class: `status-chip s-${RUN_ACTIVE.has(r.status) ? "working" : r.status === "failed" ? "error" : r.status === "completed" ? "completed" : "idle"}` }, RUN_LABEL[r.status] || r.status),
    h("span", { class: "grow" }, h("b", {}, trunc(r.request, 90)), h("small", {}, `#${r.id} · ${fmtDate(r.created_at)}${r.task_type ? ` · ${r.task_type}` : ""}`)),
    h("span", { class: "task-agents" }, r.agents.slice(0, 5).map((a) => h("span", { class: "mini-glyph", title: a.agent_id }, agentGlyphSvg(a.role || "ASSISTANT", 22))))))
    : [empty("Sin tareas", "Cada petición que hagas en AI Workspace se convierte en una tarea con su plan, agentes y resultado.", h("a", { class: "btn primary", href: `#/p/${WS.pid}/workspace` }, "Abrir AI Workspace"))]);
  const detail = h("div", { class: "stack" });
  body.replaceChildren(h("div", { class: "tasks-layout" }, h("section", { class: "card" }, h("div", { class: "card-h" }, `Tareas · ${runs.length}`), list), detail));
  if (!selected) return;
  const data = await api("GET", `/api/workspace/runs/${selected}`);
  const graph = h("div", { class: "net-wrap" });
  const replayBox = h("div", {});
  const tl = h("ol", { class: "timeline-list" });
  renderTimeline(tl, data.events, { agentsById: WS.agentsById });
  const steps = h("div", { class: "table-wrap" }, h("table", { class: "log" }, h("thead", {}, h("tr", {}, ["Paso", "Agente", "Tarea", "Depende de", "Estado", "Tiempo", ""].map((c) => h("th", {}, c)))),
    h("tbody", {}, data.agents.map((a) => h("tr", {},
      h("td", { class: "num" }, a.step), h("td", {}, agentInfo(a, WS.agentsById).name), h("td", {}, trunc(a.task, 90)), h("td", { class: "num" }, a.depends_on.join(", ") || "—"),
      h("td", {}, h("span", { class: `net-state s-${visOf(a)}` }, a.status)), h("td", { class: "num" }, a.execution_ms != null ? fmtMs(a.execution_ms) : "—"),
      h("td", {}, h("button", { class: "btn small ghost", type: "button", onclick: () => openAgentDrawer({ kind: "agent", row: a, role: a.role || agentInfo(a, WS.agentsById).role, vis: visOf(a), name: agentInfo(a, WS.agentsById).name }, { agentsById: WS.agentsById }) }, "Detalle")))))));
  const req = await api("GET", `/api/chat/threads/${data.run.thread_id}`).then((t) => t.messages.find((m) => m.id === data.run.message_id)).catch(() => null);
  detail.replaceChildren(
    h("section", { class: "card" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, `Task graph · #${data.run.id}`),
      h("button", { class: "btn small", type: "button", onclick: () => { mountReplay(replayBox, data, { agentsById: WS.agentsById }); replayBox.scrollIntoView({ behavior: "smooth" }); } }, icon("play", 14), "Replay execution"),
      h("a", { class: "btn small ghost", href: `#/p/${WS.pid}/workspace?t=${data.run.thread_id}` }, "Conversación")),
      h("div", { class: "card-b stack" },
        req ? h("div", { class: "req-box" }, h("span", { class: "eyebrow" }, "Petición"), h("p", {}, req.content)) : null,
        h("div", { class: "plan-line small muted" }, `Planificador: ${data.run.planner === "llm" ? "IA" : data.run.planner === "rules" ? "reglas" : data.run.planner || "—"}${data.run.reason ? ` · ${data.run.reason}` : ""}`),
        graph, steps)),
    replayBox,
    data.message ? h("section", { class: "card" }, h("div", { class: "card-h" }, "Resultado"), h("div", { class: "card-b" }, kairoMessage(data.message, WS.agentsById))) : data.run.error ? h("div", { class: "alert" }, data.run.error) : null,
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Activity timeline"), h("div", { class: "card-b" }, tl)));
  requestAnimationFrame(() => renderNetwork(graph, data, { agentsById: WS.agentsById, onSelect: (n) => openAgentDrawer(n, { agentsById: WS.agentsById }) }));
}

/* ---------------------------------------------------------------- Activity */

async function wsActivity(body, WS) {
  const agentFilter = new URLSearchParams(location.hash.split("?")[1] || "").get("agent") || "";
  const tl = h("ol", { class: "timeline-list" });
  let events = [];
  const more = h("button", { class: "btn small", type: "button" }, "Cargar más");
  const sel = h("select", { "aria-label": "Filtrar por agente" }, h("option", { value: "" }, "Todos los agentes"), h("option", { value: "kairo-reviewer" }, "Kairo Critic"),
    ...WS.reg.agents.map((a) => h("option", { value: a.id }, a.name)));
  sel.value = agentFilter;
  const draw = () => renderTimeline(tl, [...events].reverse(), { agentsById: WS.agentsById, agent: sel.value || null, relative: false, runLink: (id) => `#/p/${WS.pid}/tasks/${id}`, emptyText: "Sin actividad registrada." });
  const load = async () => {
    const before = events.length ? events[events.length - 1].id : "";
    const rows = await api("GET", `/api/workspace/projects/${WS.pid}/activity?before=${before}`);
    events = events.concat(rows);
    more.hidden = rows.length < 80;
    draw();
  };
  more.addEventListener("click", load);
  sel.addEventListener("change", draw);
  body.replaceChildren(h("section", { class: "card" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, "Live activity timeline"), sel),
    h("div", { class: "card-b stack" }, h("p", { class: "small muted" }, "Acciones, estados y resultados de cada agente. No se muestran razonamientos internos."), tl, more)));
  await load();
}

/* ---------------------------------------------------------------- Files / Memory / Analytics / Settings */

async function wsFiles(body, WS) {
  const project = await api("GET", `/api/projects/${WS.pid}`);
  const panel = h("div", {});
  body.replaceChildren(h("section", { class: "card" }, h("div", { class: "card-h" }, "Files"), h("div", { class: "card-b" },
    h("p", { class: "small muted" }, "Los archivos de texto marcados «En contexto» se envían a Kairo como contexto del proyecto (extracto)."), panel)));
  await tabFiles(panel, project);
}

async function memoryDialog(pid, preset = {}) {
  const kind = h("select", { id: "mem-kind" }, Object.entries(MEMORY_KIND).map(([id, l]) => h("option", { value: id }, l)));
  kind.value = preset.kind || "instruction";
  const content = h("textarea", { rows: 4, maxlength: 1000, required: true, id: "mem-content" });
  content.value = preset.content || "";
  const res = await formDialog({
    title: preset.id ? "Editar memoria" : "Añadir a la memoria del proyecto",
    intro: h("p", { class: "small muted" }, "Kairo usará esta información automáticamente en las tareas del proyecto."),
    fields: [field("Tipo", kind), field("Contenido", content, "Ej.: «Usa modo oscuro», «No modificar la autenticación», «El público son profesionales de 30-45 años»."), h("div")],
    submitLabel: "Guardar",
    onSubmit: async () => preset.id
      ? api("PATCH", `/api/workspace/memory/${preset.id}`, { kind: kind.value, content: content.value.trim() })
      : api("POST", `/api/workspace/projects/${pid}/memory`, { kind: kind.value, content: content.value.trim(), source: preset.source || "user" }),
  });
  if (res) toast("Memoria guardada");
  return res;
}

async function wsMemory(body, WS) {
  const box = h("div", { class: "mem-list" });
  const load = async () => {
    const rows = await api("GET", `/api/workspace/projects/${WS.pid}/memory`);
    box.replaceChildren(...(rows.length ? Object.keys(MEMORY_KIND).flatMap((k) => {
      const items = rows.filter((m) => m.kind === k);
      if (!items.length) return [];
      return [h("h3", { class: "mem-group" }, MEMORY_KIND[k]), ...items.map((m) => {
        const pin = h("input", { type: "checkbox", checked: m.pinned ? true : null, "aria-label": "Usar en el contexto" });
        pin.addEventListener("change", async () => { await api("PATCH", `/api/workspace/memory/${m.id}`, { pinned: pin.checked }); toast(pin.checked ? "Se usará en el contexto" : "No se usará en el contexto"); });
        return h("div", { class: "mem-item" + (m.pinned ? "" : " off") },
          h("div", { class: "grow" }, h("p", {}, m.content), h("small", {}, `${m.source === "kairo" ? "Guardado desde un resultado" : "Añadido por ti"} · ${fmtDate(m.updated_at)}`)),
          h("label", { class: "switch small" }, pin, "Contexto"),
          h("button", { class: "btn small ghost", type: "button", onclick: async () => { if (await memoryDialog(WS.pid, m)) load(); } }, "Editar"),
          h("button", { class: "btn small ghost danger", type: "button", "aria-label": "Eliminar", onclick: async () => {
            if (!(await confirmDialog({ title: "Eliminar de la memoria", body: "Kairo dejará de tenerlo en cuenta.", confirmLabel: "Eliminar", danger: true }))) return;
            await api("DELETE", `/api/workspace/memory/${m.id}`); load();
          } }, icon("trash", 14)));
      })];
    }) : [empty("Memoria vacía", "Añade objetivos, instrucciones, preferencias y decisiones.")]));
  };
  body.replaceChildren(h("section", { class: "card" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, "Project memory"),
    h("button", { class: "btn small primary", type: "button", onclick: async () => { if (await memoryDialog(WS.pid)) load(); } }, icon("plus", 14), "Añadir")),
    h("div", { class: "card-b stack" }, h("p", { class: "small muted" }, "Contexto persistente del proyecto. Lo marcado como «Contexto» se envía a Kairo y a los agentes en cada tarea (junto al objetivo y las instrucciones)."), box)));
  await load();
}

function barList(rows, labelOf, valueOf, fmt = (v) => v) {
  const max = Math.max(1, ...rows.map(valueOf));
  if (!rows.length) return h("p", { class: "small muted" }, "Sin datos todavía.");
  return h("div", { class: "bars2" }, rows.map((r) => h("div", { class: "bar2" }, h("span", { class: "bar2-l" }, labelOf(r)),
    h("span", { class: "bar2-t" }, h("i", { style: `width:${(valueOf(r) / max) * 100}%` })), h("b", {}, fmt(valueOf(r))))));
}

async function wsAnalytics(body, WS) {
  const a = await api("GET", `/api/workspace/projects/${WS.pid}/analytics`);
  const s = WS.ov.stats;
  const rate = s.completed + s.failed ? Math.round((s.completed / (s.completed + s.failed)) * 100) : null;
  body.replaceChildren(h("div", { class: "stack" },
    h("div", { class: "stat-grid" },
      h("div", { class: "stat" }, h("span", { class: "eyebrow" }, "Tareas"), h("b", {}, s.runs)),
      h("div", { class: "stat" }, h("span", { class: "eyebrow" }, "Éxito"), h("b", {}, rate == null ? "—" : `${rate}%`)),
      h("div", { class: "stat" }, h("span", { class: "eyebrow" }, "Tiempo medio"), h("b", {}, s.avg_ms != null ? fmtMs(s.avg_ms) : "—")),
      h("div", { class: "stat" }, h("span", { class: "eyebrow" }, "Agentes distintos"), h("b", {}, s.agents_used))),
    h("div", { class: "ov-grid" },
      h("section", { class: "card" }, h("div", { class: "card-h" }, "Tareas por día (14 días)"), h("div", { class: "card-b" }, barList(a.per_day, (r) => r.day.slice(5), (r) => r.runs))),
      h("section", { class: "card" }, h("div", { class: "card-h" }, "Tipos de tarea"), h("div", { class: "card-b" }, barList(a.by_type, (r) => r.type, (r) => r.runs)))),
    h("div", { class: "ov-grid" },
      h("section", { class: "card" }, h("div", { class: "card-h" }, "Agentes más usados"), h("div", { class: "card-b" }, barList(a.by_agent, (r) => agentInfo(r, WS.agentsById).name, (r) => r.tasks))),
      h("section", { class: "card" }, h("div", { class: "card-h" }, "Modelos elegidos por el router"), h("div", { class: "card-b" }, barList(a.by_model, (r) => r.model.replace(/^@cf\//, ""), (r) => r.tasks)))),
    h("p", { class: "small muted" }, "Datos reales de las ejecuciones de este proyecto.")));
}

async function wsSettings(body, WS) {
  const project = await api("GET", `/api/projects/${WS.pid}`);
  const name = h("input", { type: "text", value: project.name, maxlength: 80, required: true, id: "ps-name" });
  const objective = h("textarea", { rows: 3, maxlength: 1000, id: "ps-obj" }); objective.value = project.objective || "";
  const instructions = h("textarea", { rows: 5, maxlength: 20000, id: "ps-ins" }); instructions.value = project.instructions || "";
  const save = h("button", { class: "btn primary", type: "submit" }, "Guardar");
  const form = h("form", { class: "stack", novalidate: true }, field("Nombre", name), field("Objetivo", objective), field("Instrucciones para Kairo", instructions, "Reglas permanentes del proyecto (estilo, restricciones, tecnología…)."), h("div", { class: "row" }, save));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateForm(form)) return;
    await withBusy(save, async () => { await api("PATCH", `/api/projects/${WS.pid}`, { name: name.value.trim(), objective: objective.value.trim(), instructions: instructions.value }); toast("Proyecto guardado"); });
  });
  const tools = h("div", {}), connectors = h("div", {}), legacy = h("div", {}), console_ = h("div", {});
  const archived = project.status === "archived";
  body.replaceChildren(h("div", { class: "stack" },
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Proyecto"), h("div", { class: "card-b" }, form)),
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Modelo y proveedor"), h("div", { class: "card-b stack" },
      h("p", {}, h("span", { class: "status-chip s-completed" }, "AUTO"), " Kairo elige automáticamente agentes, modelo y proveedor en cada tarea según tus Ajustes de IA."),
      h("details", {}, h("summary", {}, "Avanzado: consola clásica con herramientas (repositorios, webhooks) y proveedor fijo"),
        h("p", { class: "small muted" }, "Opcional. La consola clásica ejecuta tareas con herramientas que piden confirmación (p. ej. proponer un Pull Request). Solo necesita proveedor si la usas."),
        h("h3", {}, "Proveedor de la consola"), legacy, h("h3", {}, "Herramientas"), tools, h("h3", {}, "Conectores"), connectors, h("h3", {}, "Consola"), console_))),
    h("section", { class: "card danger-zone" }, h("div", { class: "card-h" }, "Zona de riesgo"), h("div", { class: "card-b row" },
      h("button", { class: "btn", type: "button", onclick: async () => { await api("PATCH", `/api/projects/${WS.pid}`, { status: archived ? "active" : "archived" }); toast(archived ? "Proyecto restaurado" : "Proyecto archivado"); route(); } }, archived ? "Restaurar" : "Archivar"),
      h("button", { class: "btn danger", type: "button", onclick: async () => {
        if (!(await confirmDialog({ title: "Eliminar proyecto", danger: true, confirmLabel: "Eliminar", typeToConfirm: project.name, body: "Se borrarán sus tareas, memoria, archivos, conversaciones y actividad." }))) return;
        await api("DELETE", `/api/projects/${WS.pid}?confirm=true`); toast("Proyecto eliminado"); location.hash = "#/proyectos";
      } }, "Eliminar proyecto")))));
  // Reutiliza las secciones clásicas existentes (sin duplicar su lógica).
  body.querySelector("details").addEventListener("toggle", async (e) => {
    if (!e.target.open || legacy.childElementCount) return;
    await Promise.all([tabSettings(legacy, project), tabTools(tools, project), tabProjectConnectors(connectors, project), tabChat(console_, project)]).catch((err) => toast(err.message, true));
  }, { once: false });
}
