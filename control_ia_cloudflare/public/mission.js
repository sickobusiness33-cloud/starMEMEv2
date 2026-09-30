/* Mission Control del Kairo Autopilot.
 *
 * Todo lo que se ve sale de /api/autopilot/* (tablas ap_*, usage_events). Un agente aparece
 * WORKING solo si el servidor tiene una tarea suya en ejecución o revisión ahora mismo.
 */
"use strict";

const AP_STATE = {
  WORKING: ["st-ok", "Trabajando"], REVIEW: ["st-ok", "Revisando"], NEEDS_APPROVAL: ["st-warn", "Espera aprobación"],
  QUEUED: ["st-idle", "En cola"], WAITING: ["st-warn", "Esperando cupo"], IDLE: ["st-idle", "Libre"],
};
const AP_TASK = {
  pending: ["Pendiente", "st-idle", "•"], queued: ["En cola", "st-idle", "…"], running: ["Ejecutando", "st-ok", "◐"], review: ["Revisión", "st-ok", "◎"],
  done: ["Hecha", "st-ok", "✓"], failed: ["Fallida", "st-err", "✕"], needs_approval: ["Aprobación", "st-warn", "!"], waiting: ["Esperando", "st-warn", "⏸"],
  blocked: ["Bloqueada", "st-err", "⛔"], cancelled: ["Cancelada", "st-idle", "–"],
};
const AP_RISK = { low: "st-ok", medium: "st-idle", high: "st-warn", critical: "st-err" };
const apDur = (s) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const apNum = (n) => Number(n || 0).toLocaleString("es-ES");

async function viewMission(main) {
  let goalFilter = 0, statusFilter = "", lastEvent = 0;
  const head = h("div", { class: "spread" });
  const kpis = h("div", { class: "mc-kpis" });
  const goalsBox = h("div", { class: "stack" });
  const agentsBox = h("div", { class: "mc-agents" });
  const approvals = h("div", { class: "stack" });
  const tasksBox = h("div", { class: "table-wrap" });
  const feed = h("ol", { class: "mc-feed" });
  const graph = h("canvas", { class: "mc-graph", width: 640, height: 300, "aria-label": "Delegación entre agentes (24 h)" });
  const side = h("div", { class: "stack" });
  const statusSel = h("select", { "aria-label": "Filtrar tareas", onchange: (e) => { statusFilter = e.target.value; loadTasks(); } },
    h("option", { value: "" }, "Todas las tareas"), Object.entries(AP_TASK).map(([k, [l]]) => h("option", { value: k }, l)));

  main.replaceChildren(h("div", { class: "stack mc" },
    head,
    kpis,
    h("div", { class: "card" }, h("div", { class: "card-h spread" }, h("span", {}, "Objetivos 24/7"),
      h("button", { class: "btn small primary", type: "button", onclick: newGoal }, "+ Objetivo")), h("div", { class: "card-b" }, goalsBox)),
    h("div", { class: "card" }, h("div", { class: "card-h spread" }, h("span", {}, "Agentes"), h("span", { class: "live" }, "EN VIVO")), h("div", { class: "card-b" }, agentsBox)),
    h("div", { class: "card" }, h("div", { class: "card-h" }, "Esperan tu aprobación (riesgo ALTO)"), h("div", { class: "card-b" }, approvals)),
    h("div", { class: "mc-cols" },
      h("div", { class: "card" }, h("div", { class: "card-h spread" }, h("span", {}, "Tareas"), statusSel), h("div", { class: "card-b" }, tasksBox)),
      h("div", { class: "card" }, h("div", { class: "card-h" }, "Actividad en tiempo real"), h("div", { class: "card-b" }, feed))),
    h("div", { class: "mc-cols" },
      h("div", { class: "card" }, h("div", { class: "card-h" }, "Comunicación y delegación (24 h)"), h("div", { class: "card-b" }, graph)),
      h("div", { class: "card" }, h("div", { class: "card-h" }, "Herramientas, modelos, errores y decisiones"), h("div", { class: "card-b" }, side)))));

  head.replaceChildren(
    h("div", {}, h("h1", {}, "Mission Control"), h("p", { class: "muted small" }, "Kairo Autopilot trabaja en segundo plano (cron cada 5 min + cola). No necesita esta página abierta.")),
    h("a", { class: "btn small", href: "#/conectores" }, "Conectar GitHub"));

  // ---------------------------------------------------------------- objetivos
  const loadGoals = async () => {
    const { goals } = await api("GET", "/api/autopilot/goals");
    goalsBox.replaceChildren(...[].concat(goals.length ? goals.map((g) => h("div", { class: "mc-goal" + (goalFilter === g.id ? " on" : "") },
      h("button", { class: "mc-goal-main", type: "button", onclick: () => { goalFilter = goalFilter === g.id ? 0 : g.id; loadGoals(); loadTasks(); } },
        h("b", {}, g.title),
        h("span", { class: "small muted" }, `${g.project_name ? `Proyecto: ${g.project_name}` : "Sin repositorio"} · ciclo ${g.cycles} · cada ${g.cadence_minutes} min · ${g.done}/${g.tasks} hechas · ${apNum(g.tokens_today)}/${apNum(g.token_budget_day)} tokens hoy`),
        g.paused_reason ? h("span", { class: "small", style: "color:var(--warn)" }, g.paused_reason) : null),
      h("span", { class: `pill ${g.status === "active" ? "st-ok" : "st-idle"}` }, g.status === "active" ? "Activo" : g.status === "done" ? "Terminado" : "Pausado"),
      g.approvals ? h("span", { class: "pill st-warn" }, `${g.approvals} aprobación`) : null,
      h("div", { class: "row" },
        g.status === "active"
          ? h("button", { class: "btn small", type: "button", onclick: () => goalAct(g, "pause") }, "Pausar")
          : h("button", { class: "btn small primary", type: "button", onclick: () => goalAct(g, "start") }, "Arrancar"),
        g.status === "active" ? h("button", { class: "btn small ghost", type: "button", onclick: () => goalAct(g, "run") }, "Ciclo ahora") : null,
        h("button", { class: "btn small ghost", type: "button", title: "Borrar", onclick: () => delGoal(g) }, "✕"))))
      : empty("Sin objetivos", "Crea un objetivo (p. ej. «Mejorar los tests y la documentación del repositorio») y vincúlalo a un proyecto con conector de GitHub para que los agentes trabajen sobre código real.")));
  };
  const goalAct = async (g, a) => {
    try { await api("POST", `/api/autopilot/goals/${g.id}/${a}`); toast(a === "pause" ? "Pausado" : "Ciclo en marcha"); refresh(); }
    catch (e) { toast(e.message, true); }
  };
  const delGoal = async (g) => {
    if (!(await confirmDialog({ title: "Borrar objetivo", body: `Se borran sus tareas y su memoria: «${g.title}».`, confirmLabel: "Borrar", danger: true }))) return;
    try { await api("DELETE", `/api/autopilot/goals/${g.id}`); refresh(); } catch (e) { toast(e.message, true); }
  };
  async function newGoal() {
    const dash = await api("GET", "/api/dashboard");
    const title = h("input", { type: "text", maxlength: 200, placeholder: "Qué quieres que consigan los agentes" });
    const desc = h("textarea", { rows: 4, maxlength: 4000, placeholder: "Contexto, criterios de éxito, lo que NO deben tocar…" });
    const proj = h("select", {}, h("option", { value: "" }, "Sin proyecto (solo análisis)"), dash.projects.map((p) => h("option", { value: p.id }, p.name)));
    const cad = h("select", {}, [[30, "Cada 30 min"], [60, "Cada hora"], [180, "Cada 3 h"], [720, "Cada 12 h"], [1440, "Una vez al día"]].map(([v, l]) => h("option", { value: v, selected: v === 60 }, l)));
    const budget = h("input", { type: "number", min: 5000, max: 500000, step: 5000, value: 60000 });
    const create = async () => {
      try {
        const r = await api("POST", "/api/autopilot/goals", { title: title.value, description: desc.value, project_id: proj.value ? Number(proj.value) : null, cadence_minutes: Number(cad.value), token_budget_day: Number(budget.value) });
        closeDialog(true);
        await api("POST", `/api/autopilot/goals/${r.id}/start`);
        toast("Objetivo creado: el orquestador empieza su primer ciclo");
        refresh();
      } catch (e) { toast(e.message, true); }
    };
    openDialog("Nuevo objetivo 24/7", [
      field("Objetivo", title), field("Detalles", desc),
      field("Proyecto", proj, "Tu conector de GitHub activo se vincula solo a este proyecto."),
      h("div", { class: "row" }, h("div", { class: "grow" }, field("Frecuencia", cad)), h("div", { class: "grow" }, field("Tokens / día", budget))),
      h("p", { class: "small muted" }, "Riesgo BAJO: automático · MEDIO: automático + registro + revisión · ALTO (Pull Requests, pagos, auth, migraciones): necesita tu aprobación · CRÍTICO (claves, fondos, producción, borrados): bloqueado siempre."),
    ], [h("button", { class: "btn", type: "button", onclick: () => closeDialog(false) }, "Cancelar"), h("button", { class: "btn primary", type: "button", onclick: create }, "Crear y arrancar")]);
  }

  // ---------------------------------------------------------------- tareas
  const loadTasks = async () => {
    const q = new URLSearchParams();
    if (goalFilter) q.set("goal", goalFilter);
    if (statusFilter) q.set("status", statusFilter);
    const { tasks } = await api("GET", `/api/autopilot/tasks?${q}`);
    tasksBox.replaceChildren(tasks.length ? h("table", { class: "log" },
      h("thead", {}, h("tr", {}, ["#", "Agente", "Estado", "Riesgo", "Tarea"].map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", {}, tasks.slice(0, 80).map((t) => h("tr", { class: "mc-row", onclick: () => showTask(t) },
        h("td", { class: "num" }, t.id), h("td", {}, t.role), h("td", {}, pill(AP_TASK, t.status)),
        h("td", {}, h("span", { class: `pill ${AP_RISK[t.risk] || ""}` }, t.risk.toUpperCase())),
        h("td", {}, trunc(t.title, 70), t.error && t.status !== "done" ? h("div", { class: "small", style: "color:var(--err)" }, trunc(t.error, 100)) : null)))))
      : empty("Sin tareas", "Cuando un objetivo esté activo, el Planner crea aquí las tareas."));
  };
  const showTask = (t) => openDialog(`#${t.id} · ${t.title}`, [
    h("p", { class: "small muted" }, `${t.role} · ${AP_TASK[t.status]?.[0] || t.status} · riesgo ${t.risk} · intentos ${t.attempts}/${t.max_attempts}${t.escalated ? " · escalada" : ""}${t.model ? ` · ${t.model}` : ""}`),
    t.detail ? h("p", {}, t.detail) : null,
    t.last_action ? h("p", { class: "small" }, h("b", {}, "Última acción: "), t.last_action) : null,
    t.result ? h("pre", { class: "mc-pre" }, t.result) : null,
    t.error ? h("p", { class: "small", style: "color:var(--err)" }, t.error) : null,
  ], [h("button", { class: "btn", type: "button", onclick: () => closeDialog(false) }, "Cerrar")]);

  const loadApprovals = async () => {
    const { tasks } = await api("GET", "/api/autopilot/tasks?status=needs_approval");
    approvals.replaceChildren(...[].concat(tasks.length ? tasks.map((t) => h("div", { class: "mc-approval" },
      h("div", { class: "grow" },
        h("b", {}, `#${t.id} ${t.title}`),
        h("div", { class: "small muted" }, `${t.role} quiere ejecutar ${t.action?.tool || "?"}${t.action?.args?.title ? `: «${t.action.args.title}»` : ""}`),
        t.action?.thought ? h("div", { class: "small" }, t.action.thought) : null,
        Array.isArray(t.action?.args?.files) ? h("div", { class: "small muted" }, `Archivos: ${t.action.args.files.map((f) => f.path).join(", ")}`) : null),
      h("div", { class: "row" },
        h("button", { class: "btn small ghost", type: "button", onclick: () => reviewAction(t) }, "Ver cambio"),
        h("button", { class: "btn small", type: "button", onclick: () => decide(t, false) }, "Rechazar"),
        h("button", { class: "btn small primary", type: "button", onclick: () => decide(t, true) }, "Aprobar"))))
      : h("p", { class: "muted small" }, "Nada pendiente.")));
  };
  const reviewAction = (t) => openDialog(`Cambio propuesto · #${t.id}`, [
    h("p", {}, t.action?.args?.description || ""),
    (t.action?.args?.files || []).map((f) => h("details", {}, h("summary", {}, f.path), h("pre", { class: "mc-pre" }, String(f.content || "").slice(0, 20000)))),
    t.action?.args?.body ? h("pre", { class: "mc-pre" }, t.action.args.body) : null,
  ], [h("button", { class: "btn", type: "button", onclick: () => closeDialog(false) }, "Cerrar")]);
  const decide = async (t, ok) => {
    if (ok && !(await confirmDialog({ title: "Aprobar acción", body: `Se ejecutará de verdad: ${t.action?.tool}. Un Pull Request NO se fusiona solo; lo revisas en GitHub.`, confirmLabel: "Aprobar" }))) return;
    try {
      const r = await api("POST", `/api/autopilot/tasks/${t.id}/${ok ? "approve" : "reject"}`, ok ? undefined : { reason: "" });
      toast(ok ? trunc(r.message || "Hecho", 120) : "Rechazada");
      refresh();
    } catch (e) { toast(e.message, true); }
  };

  // ---------------------------------------------------------------- Mission (agentes + métricas)
  const loadMission = async () => {
    const m = await api("GET", "/api/autopilot/mission");
    const u = m.usage_24h || {};
    const c = m.counts || {};
    const kpi = (label, value, sub) => h("div", { class: "mc-kpi" }, h("span", { class: "small muted" }, label), h("b", {}, value), sub ? h("span", { class: "small muted" }, sub) : null);
    kpis.replaceChildren(
      kpi("Agentes trabajando", `${m.working}/${m.agents.length}`, `máx. ${m.limits.maxParallelPerUser} tareas en paralelo`),
      kpi("Objetivos activos", m.active_goals),
      kpi("Tareas", apNum(Object.values(c).reduce((a, b) => a + b, 0)), `${c.done || 0} hechas · ${c.failed || 0} fallidas · ${c.blocked || 0} bloqueadas`),
      kpi("Aprobaciones", c.needs_approval || 0),
      kpi("Tokens 24 h", apNum(Number(u.input_tokens) + Number(u.output_tokens)), `${apNum(u.calls)} llamadas · ${u.errors || 0} errores`),
      kpi("Coste 24 h", `$${Number(u.cost_usd || 0).toFixed(4)}`, "estimado (Workers AI gratis = $0)"),
      kpi("Tiempo de modelo 24 h", apDur(Math.round(Number(u.runtime_ms || 0) / 1000))),
    );
    agentsBox.replaceChildren(...m.agents.map((a) => h("div", { class: `mc-agent is-${a.state.toLowerCase()}` },
      h("div", { class: "spread" }, h("b", {}, a.name), h("span", { class: `pill ${AP_STATE[a.state]?.[0] || "st-idle"}` }, AP_STATE[a.state]?.[1] || a.state)),
      h("div", { class: "small muted" }, a.purpose),
      a.task ? h("div", { class: "small" }, h("b", {}, `#${a.task.id} `), trunc(a.task.title, 70)) : null,
      a.running_seconds ? h("div", { class: "small muted" }, `En marcha ${apDur(a.running_seconds)}`) : null,
      a.last_action ? h("div", { class: "small mc-last" }, trunc(a.last_action, 110)) : null,
      a.last_result ? h("div", { class: "small muted" }, `Último resultado: ${AP_TASK[a.last_result.status]?.[0] || a.last_result.status} · ${trunc(a.last_result.title, 50)}`) : null)));
    side.replaceChildren(
      h("h4", {}, "Herramientas (24 h)"),
      m.tools.length ? h("div", { class: "mc-chips" }, m.tools.map((t) => h("span", { class: "pill st-idle" }, `${t.tool} × ${t.n}`))) : h("p", { class: "muted small" }, "Aún ninguna."),
      h("h4", {}, "Modelos (24 h)"),
      m.models.length ? h("div", { class: "mc-chips" }, m.models.map((x) => h("span", { class: "pill st-idle" }, `${x.model} × ${x.calls}`))) : h("p", { class: "muted small" }, "Aún ninguno."),
      h("h4", {}, "Decisiones"),
      m.decisions.length ? h("ul", { class: "mc-list" }, m.decisions.map((d) => h("li", {}, h("span", { class: "muted" }, `${fmtTime(d.created_at)} ${d.agent}: `), trunc(d.message, 140)))) : h("p", { class: "muted small" }, "—"),
      h("h4", {}, "Errores"),
      m.errors.length ? h("ul", { class: "mc-list" }, m.errors.map((d) => h("li", { style: "color:var(--err)" }, `${fmtTime(d.created_at)} ${d.agent}: ${trunc(d.message, 140)}`))) : h("p", { class: "muted small" }, "Sin errores."),
      h("h4", {}, "Actividad por hora (24 h)"),
      h("div", { class: "mc-spark" }, m.hourly.map((x) => h("span", { title: `${x.h.slice(11)}h · ${x.n}`, style: `height:${Math.min(100, 8 + x.n * 4)}%` }))),
    );
    drawGraph(m.agents, m.links);
  };

  function drawGraph(agents, links) {
    const ctx = graph.getContext("2d");
    const W = graph.width = graph.clientWidth * devicePixelRatio || 640, H = graph.height = 300 * devicePixelRatio;
    ctx.clearRect(0, 0, W, H);
    const cs = getComputedStyle(document.documentElement);
    const fg = cs.getPropertyValue("--ink").trim() || "#ddd", acc = cs.getPropertyValue("--k-accent").trim() || "#e33", mut = cs.getPropertyValue("--muted").trim() || "#888";
    const ids = ["human", ...agents.map((a) => a.id)];
    const pos = new Map(ids.map((id, i) => {
      const ang = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
      return [id, [W / 2 + Math.cos(ang) * W * 0.4, H / 2 + Math.sin(ang) * H * 0.38]];
    }));
    const max = Math.max(1, ...links.map((l) => l.n));
    for (const l of links) {
      const a = pos.get(l.agent), b = pos.get(l.target);
      if (!a || !b) continue;
      ctx.strokeStyle = acc; ctx.globalAlpha = 0.25 + 0.75 * (l.n / max); ctx.lineWidth = (1 + 3 * (l.n / max)) * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(W / 2, H / 2, b[0], b[1]); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.font = `${11 * devicePixelRatio}px system-ui, sans-serif`; ctx.textAlign = "center";
    for (const id of ids) {
      const [x, y] = pos.get(id);
      const ag = agents.find((a) => a.id === id);
      ctx.fillStyle = ag?.state === "WORKING" || ag?.state === "REVIEW" ? acc : mut;
      ctx.beginPath(); ctx.arc(x, y, 5 * devicePixelRatio, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = fg; ctx.fillText(ag?.name || "Tú", x, y - 9 * devicePixelRatio);
    }
    if (!links.length) { ctx.fillStyle = mut; ctx.fillText("Sin delegaciones en las últimas 24 h", W / 2, H / 2); }
  }

  const loadFeed = async () => {
    const { events } = await api("GET", `/api/autopilot/events?after=0`);
    if (events[0]?.id === lastEvent) return;
    lastEvent = events[0]?.id || 0;
    feed.replaceChildren(...(events.length ? events.slice(0, 60).map((e) => h("li", { class: `mc-ev k-${e.kind}` },
      h("span", { class: "muted small num" }, fmtTime(e.created_at)), " ",
      h("b", {}, e.agent), e.target ? h("span", { class: "muted" }, ` → ${e.target}`) : null, " ",
      h("span", {}, e.message))) : [h("li", { class: "muted small" }, "Sin actividad todavía.")]));
  };

  const refresh = () => Promise.all([loadGoals(), loadMission(), loadApprovals(), loadTasks(), loadFeed()]).catch((e) => toast(e.message, true));
  await refresh();
  every(5000, () => Promise.all([loadMission(), loadFeed(), loadApprovals()]));
  every(8000, () => Promise.all([loadGoals(), loadTasks()]));
}
