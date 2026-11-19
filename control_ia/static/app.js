/* Control IA — interfaz sin dependencias ni paso de compilación.
 *
 * - Todo el DOM se construye con h() (createElement + textContent): ningún
 *   dato del usuario o de la IA se inserta como HTML, así que no hay XSS.
 * - Las peticiones de escritura envían la cabecera X-CSRF-Token.
 * - Los secretos nunca llegan aquí: la API solo dice si están guardados.
 */
"use strict";

// ---------------------------------------------------------------- utilidades

const S = {
  user: null, csrf: null, catalog: null, providers: null, projects: [],
  filter: { q: "", status: "active" }, timers: [], dialogResolve: null,
};

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    // cssText (CSSOM) está permitido por la CSP; el atributo style no.
    else if (k === "style") el.style.cssText = v;
    else if (k === "text") el.textContent = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(method, url, body, { raw = false } = {}) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (method !== "GET") opts.headers["X-CSRF-Token"] = S.csrf || "";
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  let resp;
  try { resp = await fetch(url, opts); }
  catch { throw new ApiError("No se pudo contactar con el servidor. Revisa tu conexión y reintenta.", 0); }
  if (raw) return resp;
  let data = null;
  try { data = await resp.json(); } catch { data = null; }
  if (resp.status === 401 && S.user && !url.startsWith("/api/auth/")) {
    S.user = null; toast("Tu sesión caducó. Vuelve a entrar.", true); boot(); throw new ApiError("Sesión caducada", 401);
  }
  if (!resp.ok) throw new ApiError((data && data.error) || `Error ${resp.status}`, resp.status);
  return data;
}

function toast(message, isError = false) {
  const el = h("div", { class: "toast" + (isError ? " err" : ""), role: isError ? "alert" : "status" },
    isError ? "✕ " : "✓ ", message);
  const box = document.getElementById("toasts");
  while (box.children.length >= 3) box.firstChild.remove();
  box.append(el);
  setTimeout(() => el.remove(), isError ? 7000 : 3500);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h("textarea", { class: "sr" }); ta.value = text; document.body.append(ta);
    ta.select(); document.execCommand("copy"); ta.remove();
  }
  toast("Copiado al portapapeles");
}

const fmtDate = (iso) => iso ? new Date(iso).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }) : "—";
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString("es-ES") : "—";
const trunc = (s, n) => (s || "").length > n ? s.slice(0, n - 1) + "…" : (s || "");
const fmtBytes = (n) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;

function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; }
function every(ms, fn) { const id = setInterval(() => fn().catch(() => {}), ms); S.timers.push(id); return id; }

async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true; button.setAttribute("aria-busy", "true");
  button.textContent = "…";
  try { return await fn(); }
  catch (err) { toast(err.message, true); return undefined; }
  finally { button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = label; }
}

// ------------------------------------------------------------------ estados

const RUN_STATUS = {
  pending: ["Pendiente", "st-idle", "◷"],
  running: ["Ejecutándose", "st-run", "↻"],
  awaiting_confirmation: ["Esperando confirmación", "st-warn", "!"],
  completed: ["Completada", "st-ok", "✓"],
  failed: ["Fallida", "st-err", "✕"],
  stopped: ["Detenida", "st-idle", "■"],
  cancelled: ["Cancelada", "st-idle", "⊘"],
};
const CONN_STATUS = {
  pending_config: ["Pendiente de configuración", "st-warn", "!"],
  untested: ["Sin probar", "st-idle", "?"],
  connected: ["Conectado y verificado", "st-ok", "✓"],
  error: ["Error", "st-err", "✕"],
};
const RESULT_STATUS = {
  ok: ["OK", "st-ok", "✓"], error: ["Error", "st-err", "✕"], denegado: ["Denegado", "st-err", "⊘"],
  pendiente: ["Pendiente", "st-warn", "!"],
};
const ACTION_STATUS = {
  pending: ["Esperando confirmación", "st-warn", "!"], running: ["Ejecutando", "st-run", "↻"],
  executed: ["Ejecutada", "st-ok", "✓"], failed: ["Falló", "st-err", "✕"],
  rejected: ["Rechazada", "st-idle", "⊘"], cancelled: ["Cancelada", "st-idle", "⊘"],
};
const RISK_CLASS = { lectura: "st-ok", escritura: "st-run", externa: "st-warn", publica: "st-warn", destructiva: "st-err" };
const ACTIVE = new Set(["pending", "running", "awaiting_confirmation"]);

function pill(map, key) {
  const [label, cls, icon] = map[key] || [key, "st-idle", "•"];
  return h("span", { class: `pill ${cls}` },
    h("span", { class: key === "running" ? "spin" : null, "aria-hidden": "true" }, icon), label);
}

function providerPill(p) {
  if (!p) return h("span", { class: "pill st-warn" }, "! Sin proveedor");
  if (!p.configured) return h("span", { class: "pill st-warn" }, "! Pendiente de configuración");
  if (p.status === "ok") return h("span", { class: "pill st-ok" }, "✓ Verificado");
  if (p.status === "error") return h("span", { class: "pill st-err" }, "✕ Error en la última prueba");
  return h("span", { class: "pill st-idle" }, p.requires_key ? "? Configurado, sin probar" : "? Sin probar");
}

function empty(title, text, ...actions) {
  return h("div", { class: "empty" }, h("h3", {}, title), h("p", {}, text), h("div", { class: "row", style: "justify-content:center" }, actions));
}

// ------------------------------------------------------------------ diálogos

const dialog = () => document.getElementById("dialog");

function openDialog(title, bodyNodes, footerNodes) {
  const d = dialog();
  d.replaceChildren(
    h("div", { class: "card-h" }, h("span", { id: "dialog-title" }, title)),
    h("div", { class: "card-b stack" }, bodyNodes, h("div", { class: "row", style: "justify-content:flex-end" }, footerNodes)),
  );
  if (!d.open) d.showModal();
  const first = d.querySelector("input, textarea, select, button");
  if (first) first.focus();
}

function closeDialog(value) {
  const d = dialog();
  if (d.open) d.close();
  if (S.dialogResolve) { const r = S.dialogResolve; S.dialogResolve = null; r(value); }
}

document.addEventListener("DOMContentLoaded", () => {
  dialog().addEventListener("cancel", () => closeDialog(false));
});

/** Confirmación explícita. Con `typeToConfirm` hay que escribir un texto exacto. */
function confirmDialog({ title, body, confirmLabel = "Confirmar", danger = false, typeToConfirm = null }) {
  return new Promise((resolve) => {
    S.dialogResolve = resolve;
    const ok = h("button", { class: "btn " + (danger ? "danger" : "primary"), type: "button",
      disabled: !!typeToConfirm, onclick: () => closeDialog(true) }, confirmLabel);
    const nodes = [typeof body === "string" ? h("p", {}, body) : body];
    if (typeToConfirm) {
      const input = h("input", { type: "text", id: "confirm-text", autocomplete: "off",
        oninput: (e) => { ok.disabled = e.target.value.trim() !== typeToConfirm; } });
      nodes.push(h("div", { class: "field" }, h("label", { for: "confirm-text" }, `Escribe «${typeToConfirm}» para confirmar`), input));
    }
    openDialog(title, nodes, [h("button", { class: "btn", type: "button", onclick: () => closeDialog(false) }, "Cancelar"), ok]);
  });
}

/** Formulario en diálogo. `onSubmit(form)` puede lanzar: el error se muestra dentro. */
function formDialog({ title, fields, submitLabel = "Guardar", onSubmit, intro = null }) {
  return new Promise((resolve) => {
    S.dialogResolve = resolve;
    const error = h("div", { class: "alert", role: "alert", hidden: true });
    const submit = h("button", { class: "btn primary", type: "submit" }, submitLabel);
    const form = h("form", { novalidate: true, class: "stack" }, intro, fields, error,
      h("div", { class: "row", style: "justify-content:flex-end" },
        h("button", { class: "btn", type: "button", onclick: () => closeDialog(null) }, "Cancelar"), submit));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validateForm(form)) return;
      error.hidden = true; submit.disabled = true;
      try { const result = await onSubmit(form); closeDialog(result ?? true); }
      catch (err) { error.textContent = err.message; error.hidden = false; }
      finally { submit.disabled = false; }
    });
    const d = dialog();
    d.replaceChildren(h("div", { class: "card-h" }, h("span", { id: "dialog-title" }, title)), h("div", { class: "card-b" }, form));
    if (!d.open) d.showModal();
    const first = form.querySelector("input, textarea, select");
    if (first) first.focus();
  });
}

// Validación en cliente (el servidor vuelve a validar todo).
function validateForm(form) {
  let ok = true;
  form.querySelectorAll(".field-error").forEach((e) => e.remove());
  for (const input of form.querySelectorAll("input, textarea, select")) {
    input.removeAttribute("aria-invalid");
    if (!input.checkValidity()) {
      ok = false;
      input.setAttribute("aria-invalid", "true");
      const msg = h("div", { class: "field-error", id: input.id + "-err" }, input.validationMessage);
      input.setAttribute("aria-describedby", msg.id);
      input.after(msg);
    }
  }
  if (!ok) form.querySelector('[aria-invalid="true"]').focus();
  return ok;
}

let fieldSeq = 0;
function field(labelText, control, help) {
  const id = control.id || `f${++fieldSeq}`;
  control.id = id;
  return h("div", { class: "field" }, h("label", { for: id }, labelText), control, help ? h("div", { class: "help" }, help) : null);
}

// ------------------------------------------------------------------ arranque

async function boot() {
  clearTimers();
  const status = await api("GET", "/api/auth/status").catch((e) => ({ error: e.message }));
  if (status.error) {
    document.getElementById("app").replaceChildren(h("div", { class: "auth" }, h("div", { class: "alert" }, status.error),
      h("button", { class: "btn", onclick: boot }, "Reintentar")));
    return;
  }
  S.user = status.user; S.csrf = status.csrf_token;
  if (!S.user) return renderAuth(status.needs_setup);
  S.catalog = await api("GET", "/api/catalog");
  S.providers = await api("GET", "/api/providers");
  route();
}

window.addEventListener("hashchange", () => { if (S.user) route(); });
document.addEventListener("DOMContentLoaded", boot);

function renderAuth(needsSetup) {
  const app = document.getElementById("app");
  const email = h("input", { type: "email", required: true, autocomplete: "username", maxlength: 200 });
  const password = h("input", { type: "password", required: true, autocomplete: needsSetup ? "new-password" : "current-password",
    minlength: needsSetup ? 10 : 1, maxlength: 200 });
  const error = h("div", { class: "alert", role: "alert", hidden: true });
  const fields = [];
  let token, name;
  if (needsSetup) {
    token = h("input", { type: "text", required: true, autocomplete: "off" });
    name = h("input", { type: "text", required: true, maxlength: 80 });
    fields.push(field("Token de instalación", token, "Aparece en el registro del servidor al arrancar (línea «token de instalación»)."),
      field("Tu nombre", name));
  }
  fields.push(field("Email", email), field("Contraseña", password, needsSetup ? "Mínimo 10 caracteres." : null));
  const form = h("form", { novalidate: true }, fields, error, h("button", { class: "btn primary", type: "submit" }, needsSetup ? "Crear administrador" : "Entrar"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateForm(form)) return;
    error.hidden = true;
    try {
      const body = { email: email.value.trim(), password: password.value };
      const data = needsSetup
        ? await api("POST", "/api/auth/setup", { ...body, setup_token: token.value.trim(), name: name.value.trim() })
        : await api("POST", "/api/auth/login", body);
      S.csrf = data.csrf_token; boot();
    } catch (err) { error.textContent = err.message; error.hidden = false; }
  });
  app.replaceChildren(h("div", { class: "auth" }, h("div", { class: "card" },
    h("div", { class: "strip col-azul" }),
    h("div", { class: "card-b stack" },
      h("h1", {}, "CONTROL", h("span", { class: "muted" }, "·"), "IA"),
      h("p", { class: "muted" }, needsSetup ? "Primera puesta en marcha: crea la cuenta de administrador." : "Inicia sesión para gestionar tus proyectos y asistentes."),
      form))));
}

// ------------------------------------------------------------------ esqueleto

const NAV = [
  ["proyectos", "Proyectos", "▦"], ["actividad", "Actividad", "≋"],
  ["conectores", "Conectores", "⇄"], ["configuracion", "Configuración", "⚙"],
];

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return { section: parts[0] || "proyectos", id: parts[1] ? Number(parts[1]) : null, tab: parts[2] || "chat" };
}

function route() {
  clearTimers();
  const r = parseRoute();
  const main = h("main", { id: "main", tabindex: "-1" });
  const stats = h("div", { class: "stats", "aria-label": "Resumen" });
  const pendingBadge = h("span", { class: "count", hidden: true });
  const nav = h("nav", { class: "nav", "aria-label": "Secciones" }, NAV.map(([key, label, icon]) =>
    h("a", { href: `#/${key}`, "aria-current": r.section === key ? "page" : null },
      h("span", { "aria-hidden": "true" }, icon), label, key === "actividad" ? pendingBadge : null)));
  const top = h("header", { class: "topbar" },
    h("div", { class: "brand" }, "CONTROL", h("b", {}, "·"), "IA"), stats,
    h("div", { class: "row", style: "margin-left:auto" },
      h("span", { class: "small muted" }, `${S.user.name} · ${S.user.role === "admin" ? "admin" : "miembro"}`),
      h("button", { class: "btn small", type: "button", onclick: logout }, "Salir")));
  document.getElementById("app").replaceChildren(top, h("div", { class: "layout" }, nav, main));

  const refreshStats = async () => {
    const [runs, actions] = await Promise.all([api("GET", "/api/runs?active=true"), api("GET", "/api/actions?status=pending")]);
    const running = runs.filter((x) => x.status === "running").length;
    stats.replaceChildren(
      h("span", {}, "PROYECTOS ", h("b", {}, S.projects.length || "·")),
      h("span", { class: running ? "hl" : null }, "EJECUTÁNDOSE ", h("b", {}, running)),
      h("span", {}, "EN COLA ", h("b", {}, runs.filter((x) => x.status === "pending").length)),
      h("span", { class: actions.length ? "hl" : null }, "POR CONFIRMAR ", h("b", {}, actions.length)));
    pendingBadge.hidden = !actions.length;
    pendingBadge.textContent = actions.length;
    pendingBadge.setAttribute("aria-label", `${actions.length} acciones por confirmar`);
  };
  refreshStats().catch(() => {});
  every(4000, refreshStats);

  const views = { proyectos: viewProjects, actividad: viewActivity, conectores: viewConnectors, configuracion: viewSettings };
  (views[r.section] || viewProjects)(main, r).catch((err) => main.replaceChildren(h("div", { class: "alert" }, err.message)));
}

async function logout() {
  await api("POST", "/api/auth/logout").catch(() => {});
  S.user = null; S.csrf = null; location.hash = ""; boot();
}

async function refreshProviders() { S.providers = await api("GET", "/api/providers"); }
const providerById = (id) => (S.providers || []).find((p) => p.id === id);

// ================================================================= PROYECTOS

async function viewProjects(main, r) {
  const listBox = h("ul", { "aria-label": "Lista de proyectos" });
  const search = h("input", { type: "search", placeholder: "Buscar por nombre o descripción", value: S.filter.q, "aria-label": "Buscar proyectos" });
  const filter = h("select", { "aria-label": "Filtrar proyectos" },
    [["active", "Activos"], ["archived", "Archivados"], ["all", "Todos"]].map(([v, l]) => h("option", { value: v, selected: S.filter.status === v }, l)));
  const detail = h("section", { class: "pdetail", "aria-label": "Detalle del proyecto" });
  const wrap = h("div", { class: "projects" + (r.id ? " has-detail" : "") },
    h("aside", { class: "plist card" },
      h("div", { class: "card-h spread" }, h("span", {}, "Proyectos"),
        h("button", { class: "btn small primary", type: "button", onclick: newProject }, "+ Nuevo")),
      h("div", { class: "card-b stack" }, search, filter),
      listBox),
    detail);
  main.replaceChildren(wrap);

  const loadList = async () => {
    listBox.replaceChildren(h("li", { class: "empty" }, "Cargando…"));
    const params = new URLSearchParams({ q: S.filter.q, status: S.filter.status });
    S.projects = await api("GET", `/api/projects?${params}`);
    if (!S.projects.length) {
      listBox.replaceChildren(h("li", {}, S.filter.q || S.filter.status !== "active"
        ? empty("Sin resultados", "Ningún proyecto coincide con el filtro.")
        : empty("Aún no hay proyectos", "Crea el primero para empezar.", h("button", { class: "btn primary", onclick: newProject }, "+ Nuevo proyecto"))));
      return;
    }
    listBox.replaceChildren(...S.projects.map((p) => h("li", {}, h("a", { href: `#/proyectos/${p.id}/chat`, "aria-current": p.id === r.id ? "true" : null },
      h("div", { class: "pname" }, h("span", { class: `swatch col-${p.color}`, "aria-hidden": "true" }), h("span", { class: "grow" }, p.name),
        p.active_runs ? h("span", { class: "pill st-run" }, h("span", { class: "spin", "aria-hidden": "true" }, "↻"), p.active_runs) : null),
      h("div", { class: "small muted" }, trunc(p.description, 70) || "Sin descripción"),
      h("div", { class: "row small" },
        p.is_demo ? h("span", { class: "pill badge-demo" }, "DEMO") : null,
        p.status === "archived" ? h("span", { class: "pill st-idle" }, "▣ Archivado") : null,
        h("span", { class: "muted" }, `${p.provider || "sin proveedor"} · ${p.run_count} ejecuciones`))))));
  };
  let t;
  search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { S.filter.q = search.value.trim(); loadList().catch((e) => toast(e.message, true)); }, 250); });
  filter.addEventListener("change", () => { S.filter.status = filter.value; loadList().catch((e) => toast(e.message, true)); });
  await loadList();

  if (!r.id) {
    detail.replaceChildren(h("div", { class: "card" }, empty("Selecciona un proyecto",
      "Cada proyecto tiene sus propias instrucciones, archivos, herramientas, conectores e historial.",
      h("button", { class: "btn primary", onclick: newProject }, "+ Nuevo proyecto"))));
    return;
  }
  await renderProject(detail, r);
}

function providerOptions(selected) {
  return [h("option", { value: "" }, "— Elige proveedor —"),
    ...(S.providers || []).map((p) => h("option", { value: p.id, selected: p.id === selected },
      `${p.name}${p.configured ? "" : " (pendiente de configuración)"}`))];
}

async function newProject() {
  const name = h("input", { type: "text", required: true, maxlength: 80 });
  const description = h("input", { type: "text", maxlength: 500 });
  const instructions = h("textarea", { maxlength: 20000, rows: 4 });
  const provider = h("select", {}, providerOptions(""));
  const model = h("input", { type: "text", maxlength: 120, list: "new-models" });
  const models = h("datalist", { id: "new-models" });
  provider.addEventListener("change", async () => {
    models.replaceChildren();
    if (!provider.value) return;
    const data = await api("GET", `/api/providers/${provider.value}/models`).catch(() => ({ models: [] }));
    models.replaceChildren(...data.models.map((m) => h("option", { value: m })));
    if (!model.value && data.models.length) model.value = data.models[0];
  });
  const created = await formDialog({
    title: "Nuevo proyecto", submitLabel: "Crear proyecto",
    fields: [field("Nombre", name), field("Descripción", description),
      field("Instrucciones del sistema", instructions, "Se envían al modelo en cada tarea de este proyecto."),
      field("Proveedor de IA", provider, "Puedes cambiarlo después en Ajustes."), field("Modelo", model), models],
    onSubmit: () => api("POST", "/api/projects", { name: name.value.trim(), description: description.value.trim(),
      instructions: instructions.value, provider: provider.value, model: model.value.trim() }),
  });
  if (created && created.id) { toast("Proyecto creado"); location.hash = `#/proyectos/${created.id}/chat`; }
}

const TABS = [["chat", "Chat"], ["ejecuciones", "Ejecuciones"], ["archivos", "Archivos"], ["herramientas", "Herramientas"],
  ["conectores", "Conectores"], ["ajustes", "Ajustes"]];

async function renderProject(container, r) {
  container.replaceChildren(h("div", { class: "card" }, h("div", { class: "empty" }, "Cargando proyecto…")));
  let project;
  try { project = await api("GET", `/api/projects/${r.id}`); }
  catch (err) { container.replaceChildren(h("div", { class: "card" }, empty("No se pudo abrir el proyecto", err.message, h("a", { class: "btn", href: "#/proyectos" }, "Volver")))); return; }
  const provider = providerById(project.provider);
  const tabPanel = h("div", { class: "card-b", role: "tabpanel", id: "tabpanel" });
  const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Secciones del proyecto" }, TABS.map(([key, label]) =>
    h("button", { type: "button", role: "tab", "aria-selected": r.tab === key ? "true" : "false", "aria-controls": "tabpanel",
      onclick: () => { location.hash = `#/proyectos/${project.id}/${key}`; } }, label)));
  tabs.addEventListener("keydown", (e) => {
    if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
    const idx = TABS.findIndex(([k]) => k === r.tab);
    const next = TABS[(idx + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length][0];
    location.hash = `#/proyectos/${project.id}/${next}`;
  });
  let warning = null;
  if (!project.provider || !project.model) {
    warning = h("div", { class: "note" }, "! Este proyecto no tiene proveedor o modelo. ", h("a", { href: `#/proyectos/${project.id}/ajustes` }, "Configúralo en Ajustes"), ".");
  } else if (provider && !provider.configured) {
    warning = h("div", { class: "note" }, "! ", provider.problem, " ", h("a", { href: "#/configuracion" }, "Ir a Configuración"));
  } else if (provider && provider.is_demo) {
    warning = h("div", { class: "info small" }, "Proveedor de demostración: las respuestas NO las genera una IA. Comandos de prueba: ",
      h("code", {}, "/herramienta <nombre> {json}"), " · ", h("code", {}, "/lento 10"), " · ", h("code", {}, "/fallar"));
  }
  container.replaceChildren(h("div", { class: "card" },
    h("div", { class: `strip col-${project.color}` }),
    h("div", { class: "card-b stack" },
      h("a", { class: "btn small only-mobile", href: "#/proyectos" }, "← Proyectos"),
      h("div", { class: "row spread" },
        h("div", { class: "grow phead" },
          h("h1", {}, project.name),
          h("p", { class: "muted" }, project.description || "Sin descripción")),
        h("div", { class: "row" },
          project.is_demo ? h("span", { class: "pill badge-demo" }, "DEMO — datos de ejemplo") : null,
          project.status === "archived" ? h("span", { class: "pill st-idle" }, "▣ Archivado") : null,
          h("span", { class: "pill st-idle" }, `${project.provider || "—"} / ${project.model || "—"}`),
          project.provider ? providerPill(provider) : null)),
      warning),
    tabs, tabPanel));
  const renderers = { chat: tabChat, ejecuciones: tabRuns, archivos: tabFiles, herramientas: tabTools, conectores: tabProjectConnectors, ajustes: tabSettings };
  await (renderers[r.tab] || tabChat)(tabPanel, project);
}

// ------------------------------------------------------------------ chat

function runControls(run, onChange) {
  const act = (label, path, cls = "") => h("button", { class: `btn small ${cls}`, type: "button", onclick: (e) => withBusy(e.target, async () => {
    await api("POST", `/api/runs/${run.id}/${path}`); await onChange();
  }) }, label);
  const out = [];
  if (run.status === "running") out.push(act("■ Detener", "stop", "danger"));
  if (run.status === "pending" || run.status === "awaiting_confirmation") out.push(act("⊘ Cancelar", "cancel", "danger"));
  if (["failed", "stopped", "cancelled"].includes(run.status)) out.push(act("↻ Reintentar", "retry"));
  return out;
}

function actionCard(action, onChange) {
  const tool = action.tool || { name: action.tool_id, risk: "?", permissions: [] };
  const decide = async (approve, btn) => {
    if (approve) {
      const ok = await confirmDialog({
        title: `Confirmar: ${tool.name}`, danger: tool.risk === "destructiva",
        confirmLabel: tool.risk === "destructiva" ? "Sí, borrar" : "Sí, ejecutar",
        body: h("div", { class: "stack" },
          h("p", {}, `La IA pide ejecutar «${tool.name}» (${tool.risk_label || tool.risk}).`),
          h("pre", { class: "pre info" }, JSON.stringify(action.args, null, 2)),
          h("p", { class: "small muted" }, "Revisa los datos: la petición la generó la IA y puede venir influida por contenido externo.")),
      });
      if (!ok) return;
    }
    await withBusy(btn, async () => {
      await api("POST", `/api/actions/${action.id}/${approve ? "approve" : "reject"}`);
      toast(approve ? "Acción aprobada" : "Acción rechazada"); await onChange();
    });
  };
  if (action.status !== "pending") {
    return h("div", { class: "small row" }, pill(ACTION_STATUS, action.status), h("b", {}, tool.name),
      action.decided_by ? h("span", { class: "muted" }, `por ${action.decided_by}`) : null,
      action.result ? h("span", { class: "muted pre" }, trunc(action.result, 200)) : null);
  }
  return h("div", { class: "confirm-card", role: "group", "aria-label": `Confirmación pendiente: ${tool.name}` },
    h("div", { class: "row spread" }, h("b", {}, `⚠ La IA solicita: ${tool.name}`),
      h("span", { class: `pill ${RISK_CLASS[tool.risk] || "st-warn"}` }, tool.risk_label || tool.risk)),
    h("pre", {}, JSON.stringify(action.args, null, 2)),
    tool.permissions && tool.permissions.length ? h("div", { class: "small" }, "Permisos: ", tool.permissions.join(" · ")) : null,
    h("div", { class: "row", style: "margin-top:6px" },
      h("button", { class: "btn small primary", type: "button", onclick: (e) => decide(true, e.target) }, "✓ Aprobar"),
      h("button", { class: "btn small", type: "button", onclick: (e) => decide(false, e.target) }, "✕ Rechazar")));
}

function runBox(run, onChange) {
  return h("div", { class: "runbox stack", "aria-label": `Ejecución ${run.id}` },
    h("div", { class: "row spread" },
      h("div", { class: "row" }, pill(RUN_STATUS, run.status), h("span", { class: "small muted" }, `#${run.id} · ${run.model}`),
        run.retry_of ? h("span", { class: "small muted" }, `reintento de #${run.retry_of}`) : null),
      h("div", { class: "row" }, runControls(run, onChange))),
    run.status === "pending" ? h("p", { class: "small muted" }, "En cola: se ejecutará cuando haya un hueco libre.") : null,
    run.status === "running" ? h("p", { class: "small muted" }, `Llamando al proveedor… (paso ${run.steps + 1})`) : null,
    run.output && run.status !== "completed" ? h("div", { class: "pre small" }, run.output) : null,
    run.error ? h("div", { class: "alert row spread", role: "alert" }, h("span", { class: "grow pre" }, run.error),
      h("button", { class: "btn small", type: "button", onclick: () => copyText(run.error) }, "Copiar error")) : null,
    run.actions.map((a) => actionCard(a, onChange)));
}

async function sendResult(project, text) {
  const tools = (await api("GET", `/api/projects/${project.id}/tools`)).filter((t) => t.enabled && t.available && ["discord_enviar_mensaje", "slack_enviar_mensaje"].includes(t.id));
  if (!tools.length) { toast("Habilita y conecta Discord o Slack en Herramientas/Conectores para enviar resultados.", true); return; }
  const select = h("select", {}, tools.map((t) => h("option", { value: t.id }, t.name)));
  const message = h("textarea", { required: true, maxlength: 2000, rows: 6 }); message.value = text.slice(0, 2000);
  const ack = h("input", { type: "checkbox", required: true, id: "ack-publish" });
  await formDialog({
    title: "Enviar resultado", submitLabel: "Publicar",
    intro: h("div", { class: "note" }, "! Esto publica el texto fuera de la plataforma, en el canal del conector."),
    fields: [field("Destino", select), field("Mensaje", message),
      h("label", { class: "switch", for: "ack-publish" }, ack, "Entiendo que se publicará el mensaje")],
    onSubmit: async () => {
      const res = await api("POST", `/api/projects/${project.id}/actions`, { tool_id: select.value, args: { mensaje: message.value }, confirm: true });
      if (res.is_error) throw new Error(res.result);
      toast(res.result);
    },
  });
}

async function tabChat(panel, project) {
  const convList = h("ul", { class: "convs", "aria-label": "Conversaciones" });
  const timeline = h("div", { class: "msgs", "aria-live": "polite", "aria-label": "Historial de la conversación" });
  const input = h("textarea", { id: "composer", required: true, maxlength: 50000, placeholder: "Describe la tarea para la IA… (Ctrl+Enter para enviar)" });
  const send = h("button", { class: "btn primary", type: "submit" }, "▶ Ejecutar");
  const form = h("form", { class: "composer", novalidate: true }, h("div", { class: "grow" }, h("label", { for: "composer" }, "Mensaje"), input), send);
  let conversationId = Number(sessionStorage.getItem(`conv-${project.id}`)) || null;
  let conversations = [];

  panel.replaceChildren(h("div", { class: "chat" },
    h("div", { class: "stack" },
      h("button", { class: "btn small", type: "button", onclick: () => { conversationId = null; sessionStorage.removeItem(`conv-${project.id}`); renderConvs(); refresh(); input.focus(); } }, "+ Nueva conversación"),
      convList),
    h("div", {}, timeline, form)));

  const renderConvs = () => {
    convList.replaceChildren(...conversations.map((c) => h("li", {}, h("button", { type: "button", "aria-current": c.id === conversationId ? "true" : null,
      onclick: () => { conversationId = c.id; sessionStorage.setItem(`conv-${project.id}`, c.id); renderConvs(); refresh(); } },
      h("div", {}, trunc(c.title, 40)), h("div", { class: "small muted" }, `${c.message_count} mensajes · ${fmtDate(c.updated_at)}`)))));
    if (!conversations.length) convList.replaceChildren(h("li", { class: "small muted" }, "Sin conversaciones todavía."));
  };

  const refresh = async () => {
    conversations = await api("GET", `/api/projects/${project.id}/conversations`);
    if (conversationId && !conversations.some((c) => c.id === conversationId)) conversationId = null;
    renderConvs();
    if (!conversationId) {
      timeline.replaceChildren(empty("Nueva conversación", "Escribe una tarea. Se usarán las instrucciones, archivos de contexto y herramientas de este proyecto."));
      return false;
    }
    const [detail, runs] = await Promise.all([
      api("GET", `/api/projects/${project.id}/conversations/${conversationId}`),
      api("GET", `/api/projects/${project.id}/runs?conversation_id=${conversationId}`),
    ]);
    const byMsg = new Map();
    runs.slice().reverse().forEach((run) => { const k = run.user_message_id; if (!byMsg.has(k)) byMsg.set(k, []); byMsg.get(k).push(run); });
    const assistantByRun = new Map(detail.messages.filter((m) => m.role === "assistant").map((m) => [m.run_id, m]));
    const nodes = [];
    for (const m of detail.messages.filter((x) => x.role === "user")) {
      nodes.push(h("div", { class: "msg user" }, h("div", { class: "meta" }, "Tú · ", fmtTime(m.created_at)), h("div", { class: "pre" }, m.content)));
      for (const run of byMsg.get(m.id) || []) {
        const answer = assistantByRun.get(run.id);
        if (run.status === "completed" && answer) {
          nodes.push(h("div", { class: "msg assistant" },
            h("div", { class: "meta" }, pill(RUN_STATUS, "completed"), `#${run.id} · ${run.model}`,
              run.usage && run.usage.output_tokens ? `· ${run.usage.input_tokens}→${run.usage.output_tokens} tokens` : null),
            h("div", { class: "pre" }, answer.content),
            run.actions.length ? h("div", { class: "stack", style: "margin-top:6px" }, run.actions.map((a) => actionCard(a, refresh))) : null,
            h("div", { class: "row", style: "margin-top:6px" },
              h("button", { class: "btn small", type: "button", onclick: () => copyText(answer.content) }, "Copiar"),
              h("button", { class: "btn small", type: "button", onclick: () => sendResult(project, answer.content) }, "Enviar a…"))));
        } else {
          nodes.push(runBox(run, refresh));
        }
      }
    }
    const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 60;
    timeline.replaceChildren(...nodes);
    if (atBottom) timeline.scrollTop = timeline.scrollHeight;
    return runs.some((x) => ACTIVE.has(x.status));
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateForm(form)) return;
    send.disabled = true;
    try {
      const run = await api("POST", `/api/projects/${project.id}/runs`, { input: input.value, conversation_id: conversationId });
      conversationId = run.conversation_id; sessionStorage.setItem(`conv-${project.id}`, conversationId);
      input.value = "";
      await refresh();
    } catch (err) { toast(err.message, true); }
    finally { send.disabled = false; input.focus(); }
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
  if (project.status === "archived") { input.disabled = true; send.disabled = true; input.placeholder = "Proyecto archivado: restáuralo en Ajustes para ejecutar tareas."; }

  await refresh();
  every(1500, async () => { await refresh(); });
}

// ------------------------------------------------------------------ ejecuciones

async function tabRuns(panel, project) {
  const q = h("input", { type: "search", placeholder: "Buscar en entradas, resultados y errores", "aria-label": "Buscar ejecuciones" });
  const status = h("select", { "aria-label": "Filtrar por estado" }, h("option", { value: "" }, "Todos los estados"),
    Object.entries(RUN_STATUS).map(([k, [label]]) => h("option", { value: k }, label)));
  const list = h("div", { class: "stack" });
  const searchAll = h("div", { class: "stack" });
  panel.replaceChildren(h("div", { class: "stack" }, h("div", { class: "row" }, h("div", { class: "grow" }, q), status), searchAll, list));

  const load = async () => {
    const params = new URLSearchParams({ q: q.value.trim(), status: status.value });
    const runs = await api("GET", `/api/projects/${project.id}/runs?${params}`);
    if (!runs.length) { list.replaceChildren(empty("Sin ejecuciones", q.value || status.value ? "Nada coincide con la búsqueda." : "Las tareas que lances en el chat aparecerán aquí.")); return; }
    const open = new Set([...list.querySelectorAll("details[open]")].map((d) => d.dataset.id));
    list.replaceChildren(...runs.map((run) => h("details", { class: "card", "data-id": run.id, open: open.has(String(run.id)) },
      h("summary", { class: "card-b row" }, pill(RUN_STATUS, run.status), h("span", { class: "muted" }, `#${run.id}`),
        h("span", { class: "grow" }, trunc(run.input, 90)), h("span", { class: "small muted" }, `${run.model} · ${fmtDate(run.created_at)}`)),
      h("div", { class: "card-b stack" },
        h("div", { class: "small muted" }, `Proveedor ${run.provider} · pasos ${run.steps} · tokens ${run.usage.input_tokens || 0}→${run.usage.output_tokens || 0}` +
          (run.started_at ? ` · inicio ${fmtTime(run.started_at)}` : "") + (run.finished_at ? ` · fin ${fmtTime(run.finished_at)}` : "")),
        h("div", {}, h("div", { class: "mono-up muted" }, "Entrada"), h("div", { class: "pre" }, run.input)),
        run.output ? h("div", {}, h("div", { class: "row spread" }, h("span", { class: "mono-up muted" }, "Resultado"),
          h("button", { class: "btn small", type: "button", onclick: () => copyText(run.output) }, "Copiar resultado")), h("div", { class: "pre" }, run.output)) : null,
        run.error ? h("div", { class: "alert row spread" }, h("span", { class: "grow pre" }, run.error),
          h("button", { class: "btn small", type: "button", onclick: () => copyText(run.error) }, "Copiar error")) : null,
        run.actions.map((a) => actionCard(a, load)),
        h("div", { class: "row" }, runControls(run, load))))));
  };
  const searchHistory = async () => {
    const term = q.value.trim();
    if (term.length < 2) { searchAll.replaceChildren(); return; }
    const res = await api("GET", `/api/projects/${project.id}/search?q=${encodeURIComponent(term)}`);
    searchAll.replaceChildren(h("div", { class: "info small" }, `Mensajes de conversaciones que contienen «${term}»: ${res.messages.length}`,
      res.messages.slice(0, 8).map((m) => h("div", {}, h("b", {}, m.role === "user" ? "Tú" : "IA"), ` en «${trunc(m.conversation_title, 30)}»: `, trunc(m.content, 120)))));
  };
  let t;
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { load(); searchHistory(); }, 300); });
  status.addEventListener("change", load);
  await load();
  every(3000, load);
}

// ------------------------------------------------------------------ archivos

async function tabFiles(panel, project) {
  const list = h("div", { class: "table-wrap" });
  const fileInput = h("input", { type: "file", id: "upload", accept: ".txt,.md,.json,.csv,.tsv,.py,.js,.ts,.html,.css,.yaml,.yml,.xml,.log,.toml,.ini,.sql,.sh" });
  const upload = h("button", { class: "btn primary", type: "button" }, "Subir archivo");
  const maxKb = Math.round(S.catalog.settings.max_file_bytes / 1024);
  panel.replaceChildren(h("div", { class: "stack" },
    h("div", { class: "row" }, h("label", { for: "upload", class: "sr" }, "Archivo"), fileInput, upload),
    h("p", { class: "help" }, `Solo texto UTF-8, máx. ${maxKb} KB. Marca «En contexto» para que el modelo lo reciba en cada tarea (como datos, nunca como órdenes).`),
    list));
  const load = async () => {
    const files = await api("GET", `/api/projects/${project.id}/files`);
    if (!files.length) { list.replaceChildren(empty("Sin archivos", "Sube documentos de referencia para este proyecto.")); return; }
    list.replaceChildren(h("table", { class: "log" }, h("thead", {}, h("tr", {}, ["Nombre", "Tamaño", "Subido por", "Fecha", "En contexto", ""].map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", {}, files.map((f) => {
        const toggle = h("input", { type: "checkbox", id: `ctx-${f.id}`, checked: f.include_in_context });
        toggle.addEventListener("change", async () => {
          try { await api("PATCH", `/api/projects/${project.id}/files/${f.id}`, { include_in_context: toggle.checked }); toast(toggle.checked ? "Se incluirá en el contexto" : "Excluido del contexto"); }
          catch (err) { toggle.checked = !toggle.checked; toast(err.message, true); }
        });
        return h("tr", {}, h("td", {}, f.name), h("td", { class: "num" }, fmtBytes(f.size)), h("td", {}, f.created_by), h("td", { class: "num" }, fmtDate(f.created_at)),
          h("td", {}, h("label", { class: "switch", for: `ctx-${f.id}` }, toggle, h("span", {}, f.include_in_context ? "Sí" : "No"))),
          h("td", { class: "row" },
            h("a", { class: "btn small", href: `/api/projects/${project.id}/files/${f.id}/download` }, "Descargar"),
            h("button", { class: "btn small danger", type: "button", onclick: async (e) => {
              if (!await confirmDialog({ title: "Eliminar archivo", danger: true, confirmLabel: "Eliminar", body: `Se borrará «${f.name}» de forma permanente.` })) return;
              await withBusy(e.target, async () => { await api("DELETE", `/api/projects/${project.id}/files/${f.id}?confirm=true`); toast("Archivo eliminado"); await load(); });
            } }, "Eliminar")));
      }))));
  };
  upload.addEventListener("click", () => withBusy(upload, async () => {
    const file = fileInput.files[0];
    if (!file) throw new Error("Elige un archivo primero.");
    if (file.size > S.catalog.settings.max_file_bytes) throw new Error(`El archivo supera ${maxKb} KB.`);
    const fd = new FormData(); fd.append("file", file);
    await api("POST", `/api/projects/${project.id}/files`, fd);
    fileInput.value = ""; toast("Archivo subido"); await load();
  }));
  await load();
}

// ------------------------------------------------------------------ herramientas

async function tabTools(panel, project) {
  const grid = h("div", { class: "grid" });
  panel.replaceChildren(h("div", { class: "stack" },
    h("p", { class: "help" }, "Activa solo lo que el proyecto necesita. Las herramientas externas, de publicación o destructivas SIEMPRE piden tu confirmación antes de ejecutarse, aunque las pida la IA."),
    grid));
  const render = (tools) => grid.replaceChildren(...tools.map((t) => {
    const toggle = h("input", { type: "checkbox", id: `tool-${t.id}`, checked: t.enabled });
    toggle.addEventListener("change", async () => {
      try { render(await api("PUT", `/api/projects/${project.id}/tools/${t.id}`, { enabled: toggle.checked })); toast(toggle.checked ? `«${t.name}» habilitada` : `«${t.name}» deshabilitada`); }
      catch (err) { toggle.checked = !toggle.checked; toast(err.message, true); }
    });
    return h("div", { class: "card" },
      h("div", { class: "card-h spread" }, h("span", {}, t.name), h("span", { class: `pill ${RISK_CLASS[t.risk]}` }, t.risk)),
      h("div", { class: "card-b stack" },
        h("p", {}, t.description),
        h("div", { class: "small" }, h("b", {}, "Nivel: "), t.risk_label),
        h("div", { class: "small" }, h("b", {}, "Permisos que requiere:"), h("ul", { class: "perm" }, t.permissions.map((p) => h("li", {}, p)))),
        t.requires_confirmation ? h("div", { class: "pill st-warn" }, "! Pide confirmación antes de ejecutarse") : h("div", { class: "pill st-ok" }, "✓ Se ejecuta sin confirmación (solo dentro del proyecto)"),
        !t.available ? h("div", { class: "note small" }, "! ", t.unavailable_reason, " ", h("a", { href: `#/proyectos/${project.id}/conectores` }, "Vincular conector")) : null,
        h("label", { class: "switch", for: `tool-${t.id}` }, toggle, t.enabled ? "Habilitada en este proyecto" : "Deshabilitada")));
  }));
  render(await api("GET", `/api/projects/${project.id}/tools`));
}

async function tabProjectConnectors(panel, project) {
  const list = h("div", { class: "stack" });
  panel.replaceChildren(h("div", { class: "stack" },
    h("p", { class: "help" }, "Vincula aquí qué integraciones puede usar este proyecto. Las credenciales se gestionan en la sección Conectores y se comparten solo con los proyectos vinculados."),
    list));
  const render = (rows) => {
    if (!rows.length) { list.replaceChildren(empty("No tienes conectores", "Crea uno en la sección Conectores.", h("a", { class: "btn primary", href: "#/conectores" }, "Ir a Conectores"))); return; }
    list.replaceChildren(...rows.map((c) => {
      const toggle = h("input", { type: "checkbox", id: `link-${c.id}`, checked: c.linked });
      toggle.addEventListener("change", async () => {
        try { render(await api("PUT", `/api/projects/${project.id}/connectors/${c.id}`, { linked: toggle.checked })); toast(toggle.checked ? "Conector vinculado" : "Conector desvinculado"); }
        catch (err) { toggle.checked = !toggle.checked; toast(err.message, true); }
      });
      return h("div", { class: "card card-b row spread" },
        h("div", {}, h("b", {}, c.name), " ", h("span", { class: "muted small" }, c.type)),
        h("div", { class: "row" }, pill(CONN_STATUS, c.status), c.enabled ? h("span", { class: "pill st-ok" }, "✓ Activo") : h("span", { class: "pill st-idle" }, "○ Inactivo"),
          h("label", { class: "switch", for: `link-${c.id}` }, toggle, "Vinculado")));
    }));
  };
  render(await api("GET", `/api/projects/${project.id}/connectors`));
}

// ------------------------------------------------------------------ ajustes

async function tabSettings(panel, project) {
  const name = h("input", { type: "text", required: true, maxlength: 80, value: project.name });
  const description = h("input", { type: "text", maxlength: 500, value: project.description });
  const color = h("select", {}, S.catalog.colors.map((c) => h("option", { value: c, selected: c === project.color }, c)));
  const instructions = h("textarea", { maxlength: 20000, rows: 8 }); instructions.value = project.instructions;
  const provider = h("select", {}, providerOptions(project.provider));
  const model = h("input", { type: "text", maxlength: 120, list: "model-list", value: project.model });
  const modelList = h("datalist", { id: "model-list" });
  const modelInfo = h("div", { class: "help" });
  const paramsBox = h("div", { class: "grid" });
  const limits = {
    max_runs_per_day: h("input", { type: "number", min: 1, max: 10000, required: true, value: project.limits.max_runs_per_day }),
    history_messages: h("input", { type: "number", min: 0, max: 200, required: true, value: project.limits.history_messages }),
    max_tool_steps: h("input", { type: "number", min: 1, max: 25, required: true, value: project.limits.max_tool_steps }),
  };
  let paramInputs = {};

  const loadModels = async () => {
    modelList.replaceChildren(); paramsBox.replaceChildren(); paramInputs = {}; modelInfo.replaceChildren();
    if (!provider.value) { modelInfo.textContent = "Elige un proveedor para ver sus modelos y parámetros."; return; }
    modelInfo.textContent = "Consultando modelos…";
    const data = await api("GET", `/api/providers/${provider.value}/models?model=${encodeURIComponent(model.value.trim())}`);
    modelList.replaceChildren(...data.models.map((m) => h("option", { value: m })));
    modelInfo.replaceChildren(data.verified ? h("span", { class: "pill st-ok" }, `✓ ${data.models.length} modelos disponibles (consultados a la API)`)
      : h("span", { class: "pill st-warn" }, "! Lista sugerida, sin verificar"), ...(data.warning ? [h("div", {}, data.warning)] : []));
    for (const spec of data.params) {
      const current = project.provider === provider.value ? project.params[spec.name] : undefined;
      let input;
      if (spec.type === "choice") {
        input = h("select", {}, h("option", { value: "" }, "(predeterminado del modelo)"), spec.choices.map((c) => h("option", { value: c, selected: current === c }, c)));
      } else {
        input = h("input", { type: "number", min: spec.min, max: spec.max, step: spec.type === "int" ? 1 : 0.05, value: current ?? spec.default ?? "" });
      }
      paramInputs[spec.name] = { input, spec };
      paramsBox.append(field(spec.label, input, spec.help));
    }
    if (!data.params.length && model.value) paramsBox.append(h("p", { class: "help" }, "Este proveedor no expone parámetros ajustables para el modelo."));
  };
  provider.addEventListener("change", () => loadModels().catch((e) => toast(e.message, true)));
  model.addEventListener("change", () => loadModels().catch((e) => toast(e.message, true)));

  const form = h("form", { novalidate: true, class: "stack" },
    h("h2", {}, "General"), field("Nombre", name), field("Descripción", description), field("Color", color),
    field("Instrucciones del sistema", instructions, "Se envían al modelo en todas las tareas de este proyecto, junto a las reglas de seguridad de la plataforma."),
    h("h2", {}, "Modelo de IA"), field("Proveedor", provider), field("Modelo", model), modelList, modelInfo,
    h("h3", {}, "Parámetros compatibles"), paramsBox,
    h("h2", {}, "Límites"),
    h("div", { class: "grid" }, field("Tareas máximas al día", limits.max_runs_per_day), field("Mensajes de historial enviados", limits.history_messages, "Cuántos mensajes anteriores de la conversación recibe el modelo."),
      field("Pasos máximos por tarea", limits.max_tool_steps, "Tope de llamadas al modelo en una tarea con herramientas.")),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Guardar cambios")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateForm(form)) return;
    const params = {};
    for (const [k, { input, spec }] of Object.entries(paramInputs)) {
      if (input.value === "") continue;
      params[k] = spec.type === "choice" ? input.value : Number(input.value);
    }
    try {
      await api("PATCH", `/api/projects/${project.id}`, {
        name: name.value.trim(), description: description.value.trim(), color: color.value, instructions: instructions.value,
        provider: provider.value, model: model.value.trim(), params,
        limits: Object.fromEntries(Object.entries(limits).map(([k, i]) => [k, Number(i.value)])),
      });
      toast("Ajustes guardados"); route();
    } catch (err) { toast(err.message, true); }
  });

  const archived = project.status === "archived";
  const danger = h("div", { class: "card", style: "border-color:var(--err)" }, h("div", { class: "card-h" }, "Zona de riesgo"),
    h("div", { class: "card-b row" },
      h("button", { class: "btn", type: "button", onclick: async (e) => {
        if (!archived && !await confirmDialog({ title: "Archivar proyecto", body: "No se podrán lanzar tareas nuevas hasta restaurarlo. El historial se conserva.", confirmLabel: "Archivar" })) return;
        await withBusy(e.target, async () => { await api("PATCH", `/api/projects/${project.id}`, { status: archived ? "active" : "archived" }); toast(archived ? "Proyecto restaurado" : "Proyecto archivado"); route(); });
      } }, archived ? "Restaurar proyecto" : "Archivar proyecto"),
      h("button", { class: "btn danger", type: "button", onclick: async (e) => {
        if (!await confirmDialog({ title: "Eliminar proyecto", danger: true, confirmLabel: "Eliminar definitivamente", typeToConfirm: project.name,
          body: "Se borrarán conversaciones, ejecuciones, archivos y vínculos de este proyecto. No se puede deshacer." })) return;
        await withBusy(e.target, async () => { await api("DELETE", `/api/projects/${project.id}?confirm=true`); toast("Proyecto eliminado"); location.hash = "#/proyectos"; });
      } }, "Eliminar proyecto")));
  panel.replaceChildren(h("div", { class: "stack" }, form, danger));
  await loadModels().catch((e) => { modelInfo.textContent = e.message; });
}

// ================================================================= ACTIVIDAD

async function viewActivity(main) {
  const runLog = h("div", { class: "table-wrap" });
  const dispatch = h("div", { class: "bars" });
  const confirmations = h("div", { class: "stack" });
  const q = h("input", { type: "search", placeholder: "Buscar acción, actor, objetivo o detalle", "aria-label": "Buscar en auditoría" });
  const result = h("select", { "aria-label": "Filtrar por resultado" }, h("option", { value: "" }, "Todos los resultados"),
    Object.entries(RESULT_STATUS).map(([k, [l]]) => h("option", { value: k }, l)));
  const audit = h("div", { class: "table-wrap" });
  main.replaceChildren(h("div", { class: "stack" },
    h("h1", {}, "Actividad"),
    h("div", { class: "dash" },
      h("div", { class: "card" }, h("div", { class: "card-h spread" }, h("span", {}, "Run log"), h("span", { class: "live" }, "EN VIVO")), h("div", { class: "card-b" }, runLog)),
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("div", { class: "card-h spread" }, h("span", {}, "Dispatch"), h("span", { class: "pill st-idle" }, `${S.catalog.settings.max_concurrent_runs} workers`)), h("div", { class: "card-b" }, dispatch)),
        h("div", { class: "card" }, h("div", { class: "card-h" }, "Confirmaciones pendientes"), h("div", { class: "card-b" }, confirmations)))),
    h("div", { class: "card" }, h("div", { class: "card-h" }, "Registro de auditoría"),
      h("div", { class: "card-b stack" }, h("div", { class: "row" }, h("div", { class: "grow" }, q), result), audit))));

  const loadLive = async () => {
    const [runs, actions] = await Promise.all([api("GET", "/api/runs"), api("GET", "/api/actions?status=pending")]);
    runLog.replaceChildren(runs.length ? h("table", { class: "log" },
      h("thead", {}, h("tr", {}, ["Hora", "Proyecto", "Estado", "Tarea", ""].map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", {}, runs.slice(0, 20).map((r) => h("tr", {},
        h("td", { class: "num" }, fmtTime(r.created_at)),
        h("td", {}, h("span", { class: "row" }, h("span", { class: `swatch col-${r.project_color}`, "aria-hidden": "true" }), trunc(r.project_name, 22))),
        h("td", {}, pill(RUN_STATUS, r.status)),
        h("td", {}, trunc(r.input, 60), r.error ? h("div", { class: "small", style: "color:var(--err)" }, trunc(r.error, 90)) : null),
        h("td", {}, h("a", { href: `#/proyectos/${r.project_id}/ejecuciones` }, "Ver")))))) : empty("Sin ejecuciones", "Lanza una tarea desde un proyecto."));
    const count = (s) => runs.filter((r) => r.status === s).length;
    const max = S.catalog.settings.max_concurrent_runs;
    const bar = (label, n, total) => h("div", { class: "bar" }, h("span", {}, label),
      h("div", { class: "track", role: "img", "aria-label": `${label}: ${n}` }, h("div", { class: "fill", style: `width:${Math.min(100, total ? (n / total) * 100 : 0)}%` })), h("span", {}, `${n}${total ? "/" + total : ""}`));
    dispatch.replaceChildren(bar("Corriendo", count("running"), max), bar("En cola", count("pending"), 0), bar("Esperan", count("awaiting_confirmation"), 0),
      h("div", { class: "small muted" }, `Límite: ${S.catalog.settings.runs_per_minute_per_user} tareas/min por usuario · timeout ${S.catalog.settings.provider_timeout_seconds}s · ${S.catalog.settings.provider_max_retries} reintentos`));
    confirmations.replaceChildren(...(actions.length ? actions.map((a) => h("div", { class: "stack" },
      h("div", { class: "small muted" }, `${a.project_name} · ejecución #${a.run_id ?? "—"} · ${fmtTime(a.created_at)}`), actionCard(a, loadLive)))
      : [h("p", { class: "muted small" }, "✓ Nada pendiente.")]));
  };
  const loadAudit = async () => {
    const params = new URLSearchParams({ q: q.value.trim(), result: result.value });
    const rows = await api("GET", `/api/activity?${params}`);
    audit.replaceChildren(rows.length ? h("table", { class: "log" },
      h("thead", {}, h("tr", {}, ["Fecha", "Quién", "Acción", "Proyecto", "Objetivo", "Resultado", "Detalle"].map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", {}, rows.map((e) => h("tr", {},
        h("td", { class: "num" }, fmtDate(e.ts)), h("td", {}, e.actor), h("td", {}, e.action), h("td", {}, e.project_name || "—"),
        h("td", {}, e.target || "—"), h("td", {}, pill(RESULT_STATUS, e.result)), h("td", { class: "small pre" }, trunc(e.detail, 160)))))) : empty("Sin registros", "No hay entradas que coincidan."));
  };
  let t;
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(loadAudit, 300); });
  result.addEventListener("change", loadAudit);
  await Promise.all([loadLive(), loadAudit()]);
  every(2500, loadLive);
  every(8000, loadAudit);
}

// ================================================================= CONECTORES

function connectorFields(type, existing) {
  const inputs = {};
  const nodes = type.fields.map((f) => {
    const attrs = { type: f.secret ? "password" : "text", autocomplete: "off", maxlength: 1000, placeholder: f.placeholder, spellcheck: "false" };
    if (f.pattern) attrs.pattern = f.pattern;
    if (existing) {
      if (f.secret) attrs.placeholder = existing.secrets_set[f.name] ? "Guardado. Déjalo vacío para conservarlo." : f.placeholder;
      else attrs.value = existing.config[f.name] || "";
    }
    const input = h("input", attrs);
    inputs[f.name] = { input, spec: f };
    return field(f.label + (f.secret ? " (secreto)" : ""), input, f.help || (f.secret ? "Se guarda cifrado en el servidor y nunca se vuelve a mostrar." : null));
  });
  return { inputs, nodes };
}

function collect(inputs) {
  const config = {}, secrets = {};
  for (const [name, { input, spec }] of Object.entries(inputs)) {
    const v = input.value.trim();
    if (spec.secret) { if (v) secrets[name] = v; } else config[name] = v;
  }
  return { config, secrets };
}

async function viewConnectors(main) {
  const mine = h("div", { class: "grid" });
  const catalog = h("div", { class: "grid" });
  main.replaceChildren(h("div", { class: "stack" },
    h("h1", {}, "Conectores"),
    h("p", { class: "muted" }, "Cada integración se prueba contra el servicio real. Un conector solo se puede activar si su última prueba fue correcta; si faltan datos se muestra como «Pendiente de configuración»."),
    h("h2", {}, "Mis conectores"), mine,
    h("h2", {}, "Añadir integración"), catalog));

  const load = async () => {
    const rows = await api("GET", "/api/connectors");
    if (!rows.length) { mine.replaceChildren(h("div", { class: "card" }, empty("Sin conectores", "Añade una integración del catálogo de abajo."))); return; }
    mine.replaceChildren(...rows.map((c) => {
      const type = S.catalog.connector_types.find((t) => t.id === c.type);
      return h("div", { class: "card" },
        h("div", { class: "card-h spread" }, h("span", {}, c.type_name), pill(CONN_STATUS, c.status)),
        h("div", { class: "card-b stack" },
          h("h3", {}, c.name),
          h("div", { class: "small" }, Object.entries(c.config).map(([k, v]) => h("div", {}, `${k}: `, h("b", {}, v || "—"))),
            Object.entries(c.secrets_set).map(([k, set]) => h("div", {}, `${k}: `, set ? h("b", {}, "✓ guardado (oculto)") : h("b", { style: "color:var(--warn)" }, "! falta")))),
          h("div", { class: "small muted" },
            h("div", {}, "Estado: ", c.enabled ? "✓ activo" : "○ inactivo"),
            h("div", {}, "Última prueba: ", fmtDate(c.last_tested_at)),
            h("div", {}, "Último uso: ", fmtDate(c.last_used_at)),
            h("div", {}, "Proyectos: ", c.projects.length ? c.projects.join(", ") : "ninguno")),
          c.last_error ? h("div", { class: "alert small", role: "alert" }, "Último error: ", c.last_error) : null,
          h("div", { class: "row" },
            h("button", { class: "btn small primary", type: "button", onclick: (e) => withBusy(e.target, async () => {
              const res = await api("POST", `/api/connectors/${c.id}/test`);
              toast(res.message, !res.ok); await load();
            }) }, "Probar conexión"),
            h("button", { class: "btn small", type: "button", disabled: !c.enabled && c.status !== "connected",
              title: c.status !== "connected" ? "Primero prueba la conexión con éxito" : null,
              onclick: (e) => withBusy(e.target, async () => {
                await api("POST", `/api/connectors/${c.id}/enable`, { enabled: !c.enabled });
                toast(c.enabled ? "Conector desactivado" : "Conector activado"); await load();
              }) }, c.enabled ? "Desactivar" : "Activar"),
            h("button", { class: "btn small", type: "button", onclick: async () => {
              const nameInput = h("input", { type: "text", required: true, maxlength: 80, value: c.name });
              const { inputs, nodes } = connectorFields(type, c);
              const saved = await formDialog({ title: `Editar ${c.name}`, fields: [field("Nombre", nameInput), nodes],
                intro: h("p", { class: "small muted" }, "Si cambias datos o credenciales, el conector se desactiva hasta que lo vuelvas a probar."),
                onSubmit: () => api("PATCH", `/api/connectors/${c.id}`, { name: nameInput.value.trim(), ...collect(inputs) }) });
              if (saved) { toast("Conector actualizado"); await load(); }
            } }, "Editar"),
            h("button", { class: "btn small danger", type: "button", onclick: async (e) => {
              if (!await confirmDialog({ title: "Desconectar", danger: true, confirmLabel: "Desconectar y borrar credenciales",
                body: `Se borrarán las credenciales de «${c.name}» y se desvinculará de ${c.projects.length} proyecto(s). Revoca también el token en el servicio si ya no lo usas.` })) return;
              await withBusy(e.target, async () => { await api("DELETE", `/api/connectors/${c.id}?confirm=true`); toast("Conector desconectado"); await load(); });
            } }, "Desconectar"))));
    }));
  };

  catalog.replaceChildren(...S.catalog.connector_types.map((type) => h("div", { class: "card" },
    h("div", { class: "card-h" }, type.name),
    h("div", { class: "card-b stack" },
      h("p", {}, type.description),
      h("div", { class: "small" }, h("b", {}, "Acceso que requiere:"), h("ul", { class: "perm" }, type.permissions.map((p) => h("li", {}, p)))),
      h("details", { class: "small" }, h("summary", {}, "Cómo obtener las credenciales"), h("ol", {}, type.setup_steps.map((s) => h("li", {}, s)))),
      h("button", { class: "btn primary", type: "button", onclick: async () => {
        const nameInput = h("input", { type: "text", required: true, maxlength: 80, value: type.name });
        const { inputs, nodes } = connectorFields(type, null);
        const created = await formDialog({ title: `Conectar ${type.name}`, submitLabel: "Guardar",
          intro: h("div", { class: "info small" }, "Permisos: ", type.permissions.join(" ")),
          fields: [field("Nombre", nameInput), nodes],
          onSubmit: () => api("POST", "/api/connectors", { type: type.id, name: nameInput.value.trim(), ...collect(inputs) }) });
        if (created && created.id) {
          toast(created.status === "pending_config" ? "Guardado: pendiente de configuración" : "Guardado. Ahora prueba la conexión.");
          await load();
        }
      } }, "Configurar")))));
  await load();
}

// ================================================================= CONFIGURACIÓN

async function viewSettings(main) {
  await refreshProviders();
  const isAdmin = S.user.role === "admin";
  const providers = h("div", { class: "grid" });
  const renderProviders = () => providers.replaceChildren(...S.providers.map((p) => {
    const keyInput = h("input", { type: "password", autocomplete: "off", minlength: 8, maxlength: 500, placeholder: "Pega la API key", spellcheck: "false" });
    const source = p.key_source === "servidor" ? "Guardada cifrada en el servidor"
      : p.key_source === "entorno" ? `Variable de entorno ${p.key_env_var}` : p.requires_key ? "No configurada" : "No necesita API key";
    return h("div", { class: "card" },
      h("div", { class: "card-h spread" }, h("span", {}, p.name), providerPill(p)),
      h("div", { class: "card-b stack" },
        h("p", {}, p.description),
        p.is_demo ? h("div", { class: "note small" }, "! No es una IA: respuestas fijas para probar la plataforma.") : null,
        h("div", { class: "small" }, h("b", {}, "Credencial: "), source),
        h("div", { class: "small muted" }, p.key_help),
        h("div", { class: "small muted" }, "Última prueba: ", fmtDate(p.last_tested_at), " · último uso: ", fmtDate(p.last_used_at)),
        p.problem ? h("div", { class: "note small" }, p.problem) : null,
        p.last_error ? h("div", { class: "alert small" }, "Último error: ", p.last_error) : null,
        p.requires_key && isAdmin ? h("form", { class: "row", novalidate: true, onsubmit: async (e) => {
          e.preventDefault();
          if (!validateForm(e.target)) return;
          try { await api("PUT", `/api/providers/${p.id}/key`, { api_key: keyInput.value.trim() }); keyInput.value = ""; toast("API key guardada (cifrada)"); await refreshProviders(); renderProviders(); }
          catch (err) { toast(err.message, true); }
        } }, h("label", { class: "sr", for: `key-${p.id}` }, `API key de ${p.name}`), Object.assign(keyInput, { id: `key-${p.id}` }),
          h("button", { class: "btn small", type: "submit" }, "Guardar clave")) : null,
        p.requires_key && !isAdmin ? h("p", { class: "small muted" }, "Solo un administrador puede cambiar credenciales.") : null,
        h("div", { class: "row" },
          h("button", { class: "btn small primary", type: "button", onclick: (e) => withBusy(e.target, async () => {
            const res = await api("POST", `/api/providers/${p.id}/test`); toast(res.message, !res.ok); await refreshProviders(); renderProviders();
          }) }, "Probar conexión"),
          p.key_source === "servidor" && isAdmin ? h("button", { class: "btn small danger", type: "button", onclick: async (e) => {
            if (!await confirmDialog({ title: "Borrar API key", danger: true, confirmLabel: "Borrar", body: `Los proyectos que usan ${p.name} dejarán de funcionar hasta que configures otra clave.` })) return;
            await withBusy(e.target, async () => { await api("DELETE", `/api/providers/${p.id}/key`); toast("Clave borrada"); await refreshProviders(); renderProviders(); });
          } }, "Borrar clave") : null)));
  }));
  renderProviders();

  const settings = S.catalog.settings;
  const limits = h("table", { class: "log" }, h("tbody", {}, [
    ["Ejecuciones simultáneas", settings.max_concurrent_runs], ["Tareas por minuto y usuario", settings.runs_per_minute_per_user],
    ["Timeout por llamada al proveedor", `${settings.provider_timeout_seconds} s`], ["Reintentos ante errores temporales", settings.provider_max_retries],
    ["Tamaño máximo de archivo", fmtBytes(settings.max_file_bytes)], ["Duración de la sesión", `${settings.session_hours} h`],
    ["Cookie solo por HTTPS", settings.cookie_secure ? "sí" : "no (actívalo en producción)"],
  ].map(([k, v]) => h("tr", {}, h("th", { scope: "row" }, k), h("td", {}, String(v))))));

  const users = h("div", { class: "stack" });
  const loadUsers = async () => {
    const rows = await api("GET", "/api/auth/users");
    const email = h("input", { type: "email", required: true, maxlength: 200 });
    const name = h("input", { type: "text", required: true, maxlength: 80 });
    const pwd = h("input", { type: "password", required: true, minlength: 10, maxlength: 200, autocomplete: "new-password" });
    const role = h("select", {}, h("option", { value: "member" }, "Miembro"), h("option", { value: "admin" }, "Administrador"));
    const form = h("form", { novalidate: true, class: "grid" }, field("Email", email), field("Nombre", name), field("Contraseña inicial", pwd, "Mín. 10 caracteres."), field("Rol", role),
      h("div", {}, h("button", { class: "btn primary", type: "submit" }, "Crear usuario")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); if (!validateForm(form)) return;
      try { await api("POST", "/api/auth/users", { email: email.value.trim(), name: name.value.trim(), password: pwd.value, role: role.value }); toast("Usuario creado"); await loadUsers(); }
      catch (err) { toast(err.message, true); }
    });
    users.replaceChildren(h("table", { class: "log" }, h("thead", {}, h("tr", {}, ["Email", "Nombre", "Rol", "Alta"].map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", {}, rows.map((u) => h("tr", {}, h("td", {}, u.email), h("td", {}, u.name), h("td", {}, u.role === "admin" ? "Administrador" : "Miembro"), h("td", { class: "num" }, fmtDate(u.created_at)))))),
    h("p", { class: "help" }, "Cada usuario solo ve sus propios proyectos y conectores. Los administradores gestionan las claves de proveedores y ven toda la auditoría."), form);
  };

  const current = h("input", { type: "password", required: true, autocomplete: "current-password" });
  const next = h("input", { type: "password", required: true, minlength: 10, autocomplete: "new-password" });
  const pwForm = h("form", { novalidate: true, class: "stack" }, field("Contraseña actual", current), field("Nueva contraseña", next, "Mín. 10 caracteres."),
    h("button", { class: "btn", type: "submit" }, "Cambiar contraseña"));
  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault(); if (!validateForm(pwForm)) return;
    try { await api("POST", "/api/auth/password", { current_password: current.value, new_password: next.value }); current.value = next.value = ""; toast("Contraseña cambiada"); }
    catch (err) { toast(err.message, true); }
  });

  main.replaceChildren(h("div", { class: "stack" },
    h("h1", {}, "Configuración"),
    h("h2", {}, "Proveedores de IA"),
    h("p", { class: "muted" }, "Las claves se guardan cifradas en el servidor (o se leen de variables de entorno) y nunca se envían al navegador. «Probar conexión» hace una llamada real al proveedor."),
    providers,
    h("div", { class: "dash" },
      h("div", { class: "card" }, h("div", { class: "card-h" }, "Límites y configuración pública"), h("div", { class: "card-b" }, limits,
        h("p", { class: "help" }, "Se cambian con variables de entorno del servidor (ver control_ia/env.example)."))),
      h("div", { class: "card" }, h("div", { class: "card-h" }, "Mi cuenta"), h("div", { class: "card-b" }, h("p", { class: "small" }, `${S.user.email}`), pwForm))),
    isAdmin ? h("div", { class: "card" }, h("div", { class: "card-h" }, "Usuarios"), h("div", { class: "card-b" }, users)) : null));
  if (isAdmin) await loadUsers();
}
