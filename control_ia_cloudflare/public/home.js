/* DASHBOARD PRINCIPAL — Global Command Center + módulos personalizables.
 *
 * «¿Qué quieres hacer?»: el usuario escribe sin elegir proyecto, modelo ni
 * agente. El servidor analiza la petición y propone: proyecto existente,
 * proyecto nuevo o tarea independiente (el usuario confirma con un clic).
 */
"use strict";

const MODULE_LABEL = Object.fromEntries(DEFAULT_MODULES.map(([id, label]) => [id, label]));

async function viewHome(main) {
  const home = await api("GET", "/api/workspace/home");
  const reg = await api("GET", "/api/chat/agents");
  const agentsById = new Map(reg.agents.map((a) => [a.id, a]));

  // --- Command Center
  const input = h("textarea", { rows: 2, maxlength: home.limits.maxInputChars, placeholder: "Describe lo que quieres conseguir…", "aria-label": "¿Qué quieres hacer?" });
  const suggestion = h("div", { class: "cmd-suggest", "aria-live": "polite" });
  const runBtn = h("button", { class: "btn primary big", type: "submit" }, icon("bolt", 16), "Run");
  const form = h("form", { class: "cmd-form" }, input, runBtn);
  const analyze = async (text) => {
    const a = await api("POST", "/api/workspace/command/analyze", { text });
    const options = [];
    if (a.suggestion === "project") options.push(["project", `Ejecutar en «${a.project.name}»`, { type: "project", id: a.project.id }]);
    if (a.suggestion === "new") options.push(["new", `Crear proyecto «${a.new_name}»`, { type: "new", name: a.new_name, template: a.template }]);
    options.push(["standalone", "Tarea independiente", { type: "standalone" }]);
    if (a.suggestion !== "new") options.push(["new2", "Crear un proyecto nuevo…", null]);
    const go = async (target, btn) => {
      if (!target) {
        const nameInput = h("input", { type: "text", required: true, maxlength: 80, id: "cmd-pname", value: text.split(/\s+/).slice(0, 5).join(" ") });
        const name = await formDialog({ title: "Nuevo proyecto", fields: [field("Nombre del proyecto", nameInput)], submitLabel: "Crear y ejecutar", onSubmit: async () => nameInput.value.trim() });
        if (!name) return;
        target = { type: "new", name: String(name).slice(0, 80), template: "custom" };
      }
      await withBusy(btn, async () => {
        const res = await api("POST", "/api/workspace/command/run", { text, target });
        location.hash = res.project_id ? `#/p/${res.project_id}/workspace?t=${res.thread_id}` : `#/chat/${res.thread_id}`;
      });
    };
    suggestion.replaceChildren(h("div", { class: "cmd-card" },
      h("div", { class: "cmd-why" }, kairoLogo(20, "thinking"), h("span", {}, a.reason)),
      h("div", { class: "row" }, options.map(([id, label, target], i) => {
        const b = h("button", { class: `btn ${i === 0 ? "primary" : ""}`, type: "button" }, label);
        b.addEventListener("click", () => go(target, b));
        return b;
      }))));
    suggestion.querySelector("button")?.focus();
  };
  form.addEventListener("submit", async (e) => { e.preventDefault(); const t = input.value.trim(); if (t.length >= 2) await withBusy(runBtn, () => analyze(t)); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });

  const hero = h("section", { class: "cmd" },
    h("div", { class: "cmd-glow", "aria-hidden": "true" }),
    h("div", { class: "cmd-inner" },
      h("div", { class: "eyebrow" }, "Control IA · the control center for AI agents"),
      h("h1", { class: "cmd-title" }, "¿Qué quieres hacer?"),
      h("p", { class: "muted" }, `Escribe tu objetivo. ${BRAND_NAME} lo analiza, elige proyecto, agentes y modelos, y verás cómo lo ejecutan.`),
      form, suggestion,
      h("div", { class: "cmd-chips" }, ["Crea una landing page para mi app de fitness", "Investiga a mis 3 competidores y hazme un informe", "Escribe 5 posts para LinkedIn sobre IA"].map((s) =>
        h("button", { type: "button", class: "chip-btn", onclick: () => { input.value = s; input.focus(); } }, s)))));

  // --- Módulos
  const modules = {
    agents: () => {
      const live = home.live.filter(Boolean);
      const netBox = h("div", { class: "net-wrap" });
      if (live[0]) requestAnimationFrame(() => renderNetwork(netBox, live[0], { agentsById, compact: true, onSelect: (n) => openAgentDrawer(n, { agentsById }) }));
      return mod("agents", "AI Agents", live.length ? h("span", { class: "kx-live" }, "LIVE") : null,
        live.length ? h("div", { class: "stack" }, h("p", { class: "small muted" }, `${live.length} tarea(s) en curso · ${trunc(live[0].run.reason || "", 80)}`), netBox)
          : h("div", { class: "mod-empty" }, h("div", { class: "agent-dots" }, reg.agents.slice(0, 7).map((a) => h("span", { class: "mini-glyph", title: a.name }, agentGlyphSvg(a.role, 26)))),
            h("p", {}, h("b", {}, home.agents.available), " agentes disponibles", home.agents.locked ? ` · ${home.agents.locked} PRO` : ""),
            h("p", { class: "small muted" }, "Ahora mismo no hay agentes trabajando. Aparecerán aquí cuando ejecutes una petición.")));
    },
    projects: () => mod("projects", "Proyectos recientes", h("a", { class: "btn small ghost", href: "#/proyectos" }, "Todos"),
      home.projects.length ? h("div", { class: "mod-list" }, home.projects.map((p) => h("a", { class: "mod-row", href: `#/p/${p.id}/overview` },
        h("span", { class: `dot s-${p.active ? "working" : "idle"}` }), h("span", { class: "grow" }, h("b", {}, p.name), h("small", {}, trunc(p.objective || p.description || "", 70))),
        h("span", { class: "small muted" }, `${p.runs} tareas`))))
        : h("div", { class: "mod-empty" }, h("p", { class: "small muted" }, "Aún no tienes proyectos."), h("button", { class: "btn small primary", type: "button", onclick: newProjectOS }, "Crear proyecto"))),
    activity: () => {
      const tl = h("ol", { class: "timeline-list" });
      renderTimeline(tl, home.events, { agentsById, relative: false, runLink: (id) => { const r = home.recent_runs.find((x) => x.id === id); return r?.project_id ? `#/p/${r.project_id}/tasks/${id}` : r ? `#/chat/${r.thread_id}` : "#/home"; }, emptyText: "Sin actividad todavía." });
      return mod("activity", "Actividad", null, tl);
    },
    tasks: () => mod("tasks", "Tareas", null, h("div", { class: "stack" },
      h("div", { class: "mini-stats" }, [["Activas", home.tasks.active], ["Completadas", home.tasks.completed], ["Fallidas", home.tasks.failed], ["Total", home.tasks.total]].map(([l, v]) => h("div", {}, h("b", {}, v), h("span", {}, l)))),
      home.recent_runs.length ? h("div", { class: "mod-list" }, home.recent_runs.slice(0, 5).map((r) => h("a", { class: "mod-row", href: r.project_id ? `#/p/${r.project_id}/tasks/${r.id}` : `#/chat/${r.thread_id}` },
        h("span", { class: `dot s-${RUN_ACTIVE.has(r.status) ? "working" : r.status === "failed" ? "error" : "completed"}` }), h("span", { class: "grow" }, h("b", {}, trunc(r.request, 60)), h("small", {}, r.project_name || "Tarea independiente")),
        h("span", { class: "small muted" }, hhmm(r.created_at))))) : h("p", { class: "small muted" }, "Sin tareas todavía."))),
    usage: () => {
      const u = home.usage_today, L = home.limits;
      const bar = (label, used, max) => h("div", { class: "usage-row" }, h("div", { class: "row spread" }, h("span", {}, label), h("b", {}, `${used}/${max}`)), h("span", { class: "mc-bar" }, h("i", { style: `width:${Math.min(100, (used / max) * 100)}%` })));
      return mod("usage", "Uso de hoy", h("a", { class: "plan-badge", href: "#/upgrade" }, home.plan.toUpperCase()),
        h("div", { class: "stack" }, bar("Mensajes", u.chat, L.chatMessagesPerDay), bar("Ejecuciones del Hub", u.agents, L.agentRunsPerDay), bar("Imágenes", u.images, L.imagesPerDay)));
    },
    analytics: () => mod("analytics", "Agentes más usados", null, barList(home.agents.most_used, (r) => agentInfo(r, agentsById).name, (r) => r.n)),
    system: () => {
      const cooling = home.models.filter((m) => m.status !== "ready");
      return mod("system", "Estado del sistema", null, h("div", { class: "stack" },
        h("p", {}, h("span", { class: `dot s-${cooling.length ? "waiting" : "completed"}` }), cooling.length ? ` ${cooling.length} modelo(s) en enfriamiento (se usa respaldo automático)` : " Todos los modelos operativos"),
        h("p", { class: "small muted" }, `${home.models.filter((m) => m.kind === "text").length} modelos de texto · ${home.models.filter((m) => m.kind === "image").length} de imagen · router AUTO`)));
    },
    files: () => mod("files", "Archivos recientes", h("a", { class: "btn small ghost", href: "#/studio" }, "Estudio"),
      home.images.length ? h("div", { class: "thumbs" }, home.images.map((im) => h("a", { href: imgUrl(im.id), target: "_blank", rel: "noopener", title: im.prompt }, h("img", { src: imgUrl(im.id), alt: im.prompt || "Imagen", loading: "lazy" }))))
        : h("p", { class: "small muted" }, "Las imágenes que generes aparecerán aquí.")),
    providers: () => mod("providers", "Proveedores de IA", h("span", { class: "status-chip s-completed" }, "AUTO"), h("div", { class: "stack" },
      h("p", { class: "small muted" }, "La selección es automática. Este panel es solo informativo; puedes ocultarlo en Personalizar."),
      h("div", { class: "prov-grid" }, [["free", "Cloudflare AI (gratis)"], ["platform", "Claude (Pro)"], ["user", "Tu API (OpenAI/Anthropic)"]].map(([src, label]) => {
        const ms = home.models.filter((m) => m.source === src);
        return h("div", { class: "prov" }, h("b", {}, label), h("small", {}, `${ms.filter((m) => m.status === "ready").length}/${ms.length} listos`));
      })), h("a", { class: "btn small ghost", href: "#/configuracion" }, "Ajustes de IA"))),
  };
  const mod = (id, title, extra, content) => h("section", { class: "card mod", "data-mod": id }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, title), extra), h("div", { class: "card-b" }, content));

  const grid = h("div", { class: `mod-grid cols-${PREFS.data.dashboard.layout || 3}` });
  grid.append(...PREFS.data.dashboard.modules.filter((m) => m.on && modules[m.id]).map((m) => modules[m.id]()));
  main.replaceChildren(h("div", { class: "stack home" }, hero,
    h("div", { class: "row spread" }, h("h2", {}, "Tu centro de control"), h("button", { class: "btn small ghost", type: "button", onclick: () => customizeDashboard() }, icon("sliders", 15), "Personalizar")),
    grid));
  input.focus();
  // Solo se refresca a menudo mientras hay trabajo en curso.
  if (home.live.length) every(8000, async () => { const h2 = await api("GET", "/api/workspace/home"); if (!h2.live.length || h2.live[0]?.run.version !== home.live[0]?.run.version) route(); });
}

/** Personalizador: mostrar/ocultar, reordenar (arrastrar o flechas), columnas, densidad y animaciones. */
function customizeDashboard() {
  const mods = PREFS.data.dashboard.modules.map((m) => ({ ...m }));
  const list = h("ol", { class: "cust-list" });
  let dragIdx = null;
  const render = () => list.replaceChildren(...mods.map((m, i) => {
    const cb = h("input", { type: "checkbox", checked: m.on ? true : null, "aria-label": `Mostrar ${MODULE_LABEL[m.id]}` });
    cb.addEventListener("change", () => { m.on = cb.checked; });
    const li = h("li", { class: "cust-item", draggable: "true" },
      h("span", { class: "grip", "aria-hidden": "true" }, "⋮⋮"), h("label", { class: "switch" }, cb, MODULE_LABEL[m.id]),
      h("span", { class: "grow" }),
      h("button", { class: "btn small ghost", type: "button", "aria-label": "Subir", disabled: i === 0 ? true : null, onclick: () => { [mods[i - 1], mods[i]] = [mods[i], mods[i - 1]]; render(); } }, "↑"),
      h("button", { class: "btn small ghost", type: "button", "aria-label": "Bajar", disabled: i === mods.length - 1 ? true : null, onclick: () => { [mods[i + 1], mods[i]] = [mods[i], mods[i + 1]]; render(); } }, "↓"));
    li.addEventListener("dragstart", () => { dragIdx = i; li.classList.add("dragging"); });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => e.preventDefault());
    li.addEventListener("drop", (e) => { e.preventDefault(); if (dragIdx === null || dragIdx === i) return; const [x] = mods.splice(dragIdx, 1); mods.splice(i, 0, x); dragIdx = null; render(); });
    return li;
  }));
  render();
  const layout = h("select", { id: "cust-layout" }, [1, 2, 3].map((n) => h("option", { value: n }, `${n} columna${n > 1 ? "s" : ""}`)));
  layout.value = String(PREFS.data.dashboard.layout || 3);
  const density = h("select", { id: "cust-density" }, [["compact", "Compacta"], ["comfortable", "Cómoda"], ["spacious", "Amplia"]].map(([v, l]) => h("option", { value: v }, l)));
  density.value = PREFS.data.theme.density;
  const anim = h("input", { type: "checkbox", checked: PREFS.data.visuals.anim !== "off" ? true : null });
  openDialog("Personalizar dashboard", [
    h("p", { class: "small muted" }, "Arrastra para reordenar (o usa las flechas). Se guarda en tu cuenta."), list,
    h("div", { class: "st-grid2" }, field("Distribución", layout), field("Densidad", density)),
    h("label", { class: "switch" }, anim, "Animaciones"),
  ], [
    h("button", { class: "btn", type: "button", onclick: () => closeDialog(false) }, "Cancelar"),
    h("button", { class: "btn primary", type: "button", onclick: () => {
      setPrefs({ dashboard: { modules: mods, layout: Number(layout.value) }, theme: { density: density.value }, visuals: { anim: anim.checked ? (PREFS.data.visuals.anim === "off" ? "normal" : PREFS.data.visuals.anim) : "off" } });
      closeDialog(true); route();
    } }, "Guardar"),
  ]);
}
