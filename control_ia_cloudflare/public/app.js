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
  filter: { q: "", status: "active" }, timers: [], cleanups: [], dialogResolve: null,
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

function clearTimers() {
  S.timers.forEach(clearInterval); S.timers = [];
  S.cleanups.forEach((fn) => { try { fn(); } catch { /* ya cerrado */ } }); S.cleanups = [];
}
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
  pending: ["pendiente", "st-idle", "◷"],
  running: ["ejecutándose", "st-run", "↻"],
  awaiting_confirmation: ["confirmar", "st-warn", "!"],
  completed: ["completada", "st-ok", "✓"],
  failed: ["fallida", "st-err", "✕"],
  stopped: ["detenida", "st-idle", "■"],
  cancelled: ["cancelada", "st-idle", "⊘"],
};
const SHORT = { pending: "cola", running: "run", awaiting_confirmation: "wait", completed: "ok", failed: "err", stopped: "stop", cancelled: "cancel" };
const slug = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "proyecto";
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
const RISK_SHORT = { lectura: "lectura", lectura_externa: "lectura repo", escritura: "escritura", externa: "externa", publica: "publica", destructiva: "destructiva" };
const RISK_CLASS = { lectura: "st-ok", lectura_externa: "st-ok", escritura: "st-run", externa: "st-warn", publica: "st-warn", destructiva: "st-err" };
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
  // /upgrade (ruta directa) → vista #/upgrade conservando ?estado=…
  if (location.pathname === "/upgrade" && !location.hash) history.replaceState(null, "", `/${location.search}#/upgrade`);
  if (!S.user) return renderAuth(status.allow_signup);
  await loadPrefs();
  S.catalog = await api("GET", "/api/catalog");
  S.providers = await api("GET", "/api/providers");
  route();
}

window.addEventListener("hashchange", () => { if (S.user) route(); });
document.addEventListener("DOMContentLoaded", boot);

function renderAuth(allowSignup, mode = allowSignup ? "register" : "login") {
  const app = document.getElementById("app");
  const register = mode === "register";
  const email = h("input", { type: "email", required: true, autocomplete: "username", maxlength: 200 });
  const password = h("input", { type: "password", required: true, autocomplete: register ? "new-password" : "current-password",
    minlength: register ? 10 : 1, maxlength: 200 });
  const name = h("input", { type: "text", required: true, maxlength: 80, autocomplete: "name" });
  const error = h("div", { class: "alert", role: "alert", hidden: true });
  const fields = register
    ? [field("Tu nombre", name), field("Email", email), field("Contraseña", password, "Mínimo 10 caracteres.")]
    : [field("Email", email), field("Contraseña", password)];
  const form = h("form", { novalidate: true }, fields, error,
    h("button", { class: "btn primary", type: "submit" }, register ? "Crear cuenta gratis" : "Entrar"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validateForm(form)) return;
    error.hidden = true;
    try {
      const body = { email: email.value.trim(), password: password.value };
      const data = register
        ? await api("POST", "/api/auth/register", { ...body, name: name.value.trim() })
        : await api("POST", "/api/auth/login", body);
      S.csrf = data.csrf_token; boot();
    } catch (err) { error.textContent = err.message; error.hidden = false; }
  });
  const tabs = allowSignup ? h("div", { class: "row" },
    h("button", { class: "btn small" + (register ? " primary" : ""), type: "button", "aria-pressed": register ? "true" : "false",
      onclick: () => renderAuth(allowSignup, "register") }, "Crear cuenta"),
    h("button", { class: "btn small" + (!register ? " primary" : ""), type: "button", "aria-pressed": !register ? "true" : "false",
      onclick: () => renderAuth(allowSignup, "login") }, "Ya tengo cuenta")) : null;
  app.replaceChildren(h("div", { class: "auth" }, h("div", { class: "card" },
    h("div", { class: "node-h col-azul" }, h("span", { class: "title" }, "control-ia.acceso")),
    h("div", { class: "card-b stack" },
      h("h1", {}, "CONTROL", h("span", { class: "muted" }, "·"), "IA"),
      h("p", {}, "Conecta tus IAs (Claude, GPT) y tus repositorios, organiza tus productos en proyectos y deja que la IA los analice y proponga mejoras. Tú apruebas cada acción."),
      h("ul", { class: "perm small muted" },
        h("li", {}, "Tus claves de IA se guardan cifradas y solo las usas tú."),
        h("li", {}, "Nada se publica ni se borra sin tu confirmación."),
        h("li", {}, "Los cambios de código llegan como Pull Request: tú decides si fusionarlos.")),
      tabs, form))));
}

// ------------------------------------------------------------------ esqueleto

// [clave, etiqueta, icono, visible en la barra inferior del móvil]
const NAV = [
  ["lienzo", "Oficina", "canvas", true], ["home", "Chat", "kairo", true], ["proyectos", "Proyectos", "projects", true],
  ["coins", "Coin Studio", "coin", false], ["factory", "Fábrica", "grid", false], ["mission", "Autopilot", "bolt", false], ["hub", "Agentes", "agents", false], ["panel", "Red global", "network", false], ["studio", "Estudio", "studio", false], ["notificaciones", "Avisos", "bell", true],
  ["actividad", "Auditoría", "activity", false], ["conectores", "Conectores", "connectors", false],
  ["configuracion", "Ajustes", "settings", false], ["apariencia", "Apariencia", "brush", false],
];
const SECTION_TITLE = {
  home: "Command Center", p: "Project workspace", apariencia: "Apariencia", chat: "Kairo", hub: "Agent Hub", "hub-runs": "Agent Hub", studio: "Estudio", panel: "Red global", lienzo: "Oficina de robots", mission: "Mission Control", factory: "Kairo Factory", coins: "Coin Studio", proyectos: "Proyectos", notificaciones: "Notificaciones",
  actividad: "Actividad", conectores: "Conectores", configuracion: "Ajustes", upgrade: "Control IA Pro", fuentes: "Modelos y licencias", metricas: "Métricas",
};

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean);
  return { section: parts[0] || "lienzo", id: parts[1] ? Number(parts[1]) : null, tab: parts[2] || "chat" };
}

function route() {
  clearTimers();
  const r = parseRoute();
  const main = h("main", { id: "main", tabindex: "-1", class: `sec-${r.section}` });
  // Chat a pantalla completa (estilo ChatGPT/Claude): su propia barra lateral sustituye al menú y a la barra superior.
  if (r.section === "home" || r.section === "chat") {
    document.getElementById("app").replaceChildren(h("div", { class: "chat-shell" }, main));
    viewChat(main, r).catch((err) => main.replaceChildren(h("div", { class: "alert" }, err.message)));
    return;
  }
  const pendingBadge = h("span", { class: "count", hidden: true });
  const planBadge = h("a", { class: "plan-badge", href: "#/upgrade", title: "Tu plan" }, "…");
  billing(true).then((b) => {
    const lim = b.plans[b.subscription.plan].limits;
    planBadge.replaceChildren(h("b", {}, b.subscription.plan.toUpperCase()),
      h("span", { class: "hide-sm" }, ` ${b.usage_today.chat}/${lim.chatMessagesPerDay} mensajes`));
    planBadge.classList.toggle("pro", b.subscription.plan === "pro");
  }).catch(() => { planBadge.textContent = "plan"; });

  const isCurrent = (key) => r.section === key || (key === "home" && r.section === "chat") || (key === "hub" && ["hub-runs", "fuentes"].includes(r.section)) || (key === "proyectos" && r.section === "p");
  const navLink = ([key, label, ic, primary]) => h("a", { href: `#/${key}`, class: primary ? "primary" : "secondary", title: label, "aria-current": isCurrent(key) ? "page" : null },
    h("span", { class: "nav-ico" }, icon(ic, 19)), h("span", { class: "nav-label" }, label), key === "actividad" ? pendingBadge : null);
  const moreSheet = h("div", { class: "more-sheet", hidden: true },
    NAV.filter((n) => !n[3]).map(navLink), h("a", { href: "#/upgrade", class: "secondary" }, h("span", { class: "nav-ico" }, icon("star", 19)), h("span", { class: "nav-label" }, "Pro")));
  const moreBtn = h("button", { class: "nav-more", type: "button", "aria-expanded": "false", onclick: (e) => {
    e.stopPropagation(); moreSheet.hidden = !moreSheet.hidden; moreBtn.setAttribute("aria-expanded", String(!moreSheet.hidden)); } },
    h("span", { class: "nav-ico" }, icon("more", 19)), h("span", { class: "nav-label" }, "Más"));
  document.addEventListener("click", () => { moreSheet.hidden = true; }, { once: true });
  // Plegar/desplegar el menú lateral (se guarda en las preferencias del usuario).
  const collapsed = () => document.documentElement.dataset.nav === "collapsed";
  const navToggle = h("button", { class: "nav-toggle", type: "button", "aria-label": collapsed() ? "Desplegar menú" : "Plegar menú", "aria-expanded": String(!collapsed()),
    title: "Plegar/desplegar menú", onclick: () => {
      setPrefs({ ui: { nav: collapsed() ? "open" : "collapsed" } });
      navToggle.setAttribute("aria-expanded", String(!collapsed()));
      navToggle.setAttribute("aria-label", collapsed() ? "Desplegar menú" : "Plegar menú");
      navToggle.replaceChildren(icon(collapsed() ? "sidebarOpen" : "sidebar", 18));
    } }, icon(collapsed() ? "sidebarOpen" : "sidebar", 18));
  const nav = h("nav", { class: "nav", "aria-label": "Secciones" },
    h("div", { class: "side-top" },
      h("a", { class: "side-brand", href: "#/lienzo", title: "Control IA" }, kairoLogo(30), h("span", {}, h("b", {}, "Control IA"), h("small", {}, `${BRAND_NAME} Intelligence`))),
      navToggle),
    h("div", { class: "nav-group" }, NAV.slice(0, 4).map(navLink)),
    h("div", { class: "nav-sep" }, "Agentes"),
    h("div", { class: "nav-group" }, NAV.slice(4, 8).map(navLink)),
    h("div", { class: "nav-sep" }, "Sistema"),
    h("div", { class: "nav-group" }, NAV.slice(8).map(navLink)),
    moreBtn, moreSheet,
    h("a", { class: "side-pro", href: "#/upgrade", title: "Control IA Pro" }, icon("star", 16), h("span", {}, "Control IA Pro")));

  // Métricas del grafo (estética del panel): solo en la vista Panel.
  let stats = null;
  if (r.section === "panel") {
    stats = h("div", { class: "stats", "aria-label": "Resumen" });
    const fixed = h("span", { class: "stats-fixed" });
    const tEl = h("b", {}, "00.00"), fEl = h("b", {}, "0000");
    stats.append(fixed, h("span", {}, "T", tEl), h("span", {}, "Frame", fEl));
    startClock(tEl, fEl);
    const refreshStats = async () => {
      const [runs, actions] = await Promise.all([api("GET", "/api/runs?active=true"), api("GET", "/api/actions?status=pending")]);
      const running = runs.filter((x) => x.status === "running").length;
      const d = S.dash || {};
      fixed.replaceChildren(
        h("span", {}, "Files", h("b", {}, d.files ?? (S.projects.length ? "·" : 0))),
        h("span", { class: "hl" }, "Edges", h("b", {}, d.edges ?? "·")),
        h("span", {}, "Bus readers", h("b", {}, d.readers ?? "·")),
        h("span", {}, "Depth", h("b", {}, running)),
        h("span", { class: actions.length ? "hl" : null }, "Confirm", h("b", {}, actions.length)));
      setPending(actions.length);
    };
    refreshStats().catch(() => {});
    every(6000, refreshStats);
  }
  const setPending = (n) => { pendingBadge.hidden = !n; pendingBadge.textContent = n; pendingBadge.setAttribute("aria-label", `${n} acciones por confirmar`); };
  if (r.section !== "panel") {
    const refreshPending = async () => setPending((await api("GET", "/api/actions?status=pending")).length);
    refreshPending().catch(() => {});
    every(30_000, refreshPending);
  }

  const initials = (S.user.name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const top = h("header", { class: "topbar" },
    h("a", { class: "top-brand", href: "#/lienzo", "aria-label": "Control IA" }, kairoLogo(26)),
    h("div", { class: "top-title" }, SECTION_TITLE[r.section] || "Control IA"),
    stats,
    h("div", { class: "top-actions" },
      planBadge, notifBell(),
      h("span", { class: "avatar", title: `${S.user.name} · ${S.user.role === "admin" ? "admin" : "miembro"}` }, initials),
      h("button", { class: "btn small ghost", type: "button", onclick: logout }, "Salir")));
  document.getElementById("app").replaceChildren(h("div", { class: "layout" }, nav, h("div", { class: "workspace" }, top, main)));

  // Compatibilidad: los enlaces antiguos a proyectos abren el nuevo espacio de trabajo.
  if (r.section === "proyectos" && r.id) { location.replace(`#/p/${r.id}/${r.tab === "archivos" ? "files" : r.tab === "ajustes" ? "settings" : r.tab === "ejecuciones" ? "tasks" : "overview"}`); return; }
  const views = { home: viewHome, p: viewWorkspace, apariencia: viewAppearance, chat: viewChat, hub: viewHub, "hub-runs": viewHubRuns, upgrade: viewUpgrade, fuentes: viewSources, metricas: viewMetrics,
    studio: viewStudio, notificaciones: viewNotifications, lienzo: viewCanvas, mission: viewMission, factory: viewFactory, coins: viewCoins,
    panel: viewPanel, proyectos: viewProjectsOS, actividad: viewActivity, conectores: viewConnectors, configuracion: viewSettings };
  (views[r.section] || viewCanvas)(main, r).catch((err) => main.replaceChildren(h("div", { class: "alert" }, err.message)));
}

async function logout() {
  await api("POST", "/api/auth/logout").catch(() => {});
  S.user = null; S.csrf = null; location.hash = ""; boot();
}

async function refreshProviders() { S.providers = await api("GET", "/api/providers"); }
const providerById = (id) => (S.providers || []).find((p) => p.id === id);

// ================================================================= PROYECTOS

function providerOptions(selected) {
  return [h("option", { value: "" }, "— Elige proveedor —"),
    ...(S.providers || []).map((p) => h("option", { value: p.id, selected: p.id === selected },
      `${p.name}${p.configured ? "" : " (pendiente de configuración)"}`))];
}

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
  const input = h("textarea", { id: "composer", maxlength: 50000, placeholder: "Describe la tarea o arrastra archivos aquí… (Ctrl+Enter para enviar)" });
  const send = h("button", { class: "btn primary", type: "submit" }, "▶ Ejecutar");
  // --- Adjuntos: 📎, arrastrar y soltar, o pegar imágenes -----------------
  const attachments = []; // { id?, name, size, mime, state: "subiendo"|"listo"|"error", error? }
  const chips = h("div", { class: "att-chips", "aria-live": "polite" });
  const picker = h("input", { type: "file", multiple: true, class: "sr", id: "att-picker", tabindex: "-1",
    accept: ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.json,.csv,.tsv,.py,.js,.ts,.tsx,.jsx,.html,.css,.yaml,.yml,.xml,.log,.toml,.ini,.sql,.sh" });
  const clip = h("button", { class: "btn clip", type: "button", title: "Adjuntar archivos (PDF, imágenes, texto, código)", "aria-label": "Adjuntar archivos",
    onclick: () => picker.click() }, "📎");
  const renderChips = () => chips.replaceChildren(...attachments.map((a, i) => h("span", { class: `att-chip ${a.state}` },
    h("span", { class: "att-ico", "aria-hidden": "true" }, a.mime?.startsWith("image/") ? "▣" : a.mime === "application/pdf" ? "▤" : "≡"),
    h("span", { class: "att-name" }, trunc(a.name, 28)),
    h("span", { class: "muted" }, a.state === "subiendo" ? "subiendo…" : a.state === "error" ? a.error : fmtBytes(a.size)),
    h("button", { type: "button", class: "att-x", "aria-label": `Quitar ${a.name}`, onclick: () => { attachments.splice(i, 1); renderChips(); } }, "×"))));
  const uploadFiles = async (files) => {
    for (const file of files) {
      if (attachments.length >= 10) { toast("Máximo 10 archivos por mensaje.", true); break; }
      const a = { name: file.name || "imagen-pegada.png", size: file.size, mime: file.type, state: "subiendo" };
      attachments.push(a); renderChips();
      try {
        const fd = new FormData(); fd.append("file", file, a.name);
        const res = await api("POST", `/api/projects/${project.id}/files?auto_rename=true`, fd);
        Object.assign(a, { id: res.id, name: res.name, mime: res.mime, size: res.size, state: "listo" });
      } catch (err) { Object.assign(a, { state: "error", error: err.message }); }
      renderChips();
    }
  };
  picker.addEventListener("change", () => { uploadFiles([...picker.files]); picker.value = ""; });
  const form = h("form", { class: "composer", novalidate: true },
    h("div", { class: "grow" }, h("label", { for: "composer" }, "Mensaje"), chips, input), h("div", { class: "row" }, clip, send), picker);
  const dropZone = h("div", { class: "dropzone", "aria-hidden": "true" }, h("span", {}, "▼ suelta los archivos para adjuntarlos"));
  let conversationId = Number(sessionStorage.getItem(`conv-${project.id}`)) || null;
  let conversations = [];

  panel.replaceChildren(h("div", { class: "chat" },
    h("div", { class: "stack" },
      h("button", { class: "btn small", type: "button", onclick: () => { conversationId = null; sessionStorage.removeItem(`conv-${project.id}`); renderConvs(); refresh(); input.focus(); } }, "+ Nueva conversación"),
      convList),
    h("div", { class: "chat-main" }, timeline, form, dropZone)));
  const chatMain = panel.querySelector(".chat-main");
  let dragDepth = 0;
  chatMain.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; chatMain.classList.add("dragging"); });
  chatMain.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; chatMain.classList.remove("dragging"); } });
  chatMain.addEventListener("dragover", (e) => e.preventDefault());
  chatMain.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; chatMain.classList.remove("dragging");
    if (e.dataTransfer?.files?.length) uploadFiles([...e.dataTransfer.files]);
  });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  });

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
      nodes.push(h("div", { class: "msg user" }, h("div", { class: "meta" }, "Tú · ", fmtTime(m.created_at)), h("div", { class: "pre" }, m.content),
        (m.attachments || []).length ? h("div", { class: "att-chips", style: "margin:6px 0 0" }, m.attachments.map((a) =>
          h("a", { class: "att-chip listo", href: `/api/projects/${project.id}/files/${a.id}/download`, title: "Descargar" },
            h("span", { class: "att-ico", "aria-hidden": "true" }, a.mime?.startsWith("image/") ? "▣" : a.mime === "application/pdf" ? "▤" : "≡"),
            h("span", { class: "att-name" }, trunc(a.name, 28)), h("span", { class: "muted" }, fmtBytes(a.size))))) : null));
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
    if (attachments.some((a) => a.state === "subiendo")) { toast("Espera a que terminen de subir los adjuntos.", true); return; }
    const ready = attachments.filter((a) => a.state === "listo");
    if (!input.value.trim() && !ready.length) { toast("Escribe un mensaje o adjunta un archivo.", true); input.focus(); return; }
    send.disabled = true;
    try {
      const run = await api("POST", `/api/projects/${project.id}/runs`, { input: input.value, conversation_id: conversationId, attachment_ids: ready.map((a) => a.id) });
      conversationId = run.conversation_id; sessionStorage.setItem(`conv-${project.id}`, conversationId);
      input.value = ""; attachments.length = 0; renderChips();
      await refresh();
    } catch (err) { toast(err.message, true); }
    finally { send.disabled = false; input.focus(); }
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
  if (project.status === "archived") { input.disabled = true; send.disabled = true; clip.disabled = true; input.placeholder = "Proyecto archivado: restáuralo en Ajustes para ejecutar tareas."; }

  await refresh();
  every(1500, async () => { await refresh(); });
}

// ------------------------------------------------------------------ ejecuciones

async function tabFiles(panel, project) {
  const list = h("div", { class: "table-wrap" });
  const fileInput = h("input", { type: "file", id: "upload", accept: ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.json,.csv,.tsv,.py,.js,.ts,.tsx,.jsx,.html,.css,.yaml,.yml,.xml,.log,.toml,.ini,.sql,.sh" });
  const upload = h("button", { class: "btn primary", type: "button" }, "Subir archivo");
  const maxKb = Math.round(S.catalog.settings.max_file_bytes / 1024);
  panel.replaceChildren(h("div", { class: "stack" },
    h("div", { class: "row" }, h("label", { for: "upload", class: "sr" }, "Archivo"), fileInput, upload),
    h("p", { class: "help" }, `Texto/código (máx. ${maxKb} KB), imágenes y PDF (máx. 1 MB). «En contexto» envía un archivo de texto en cada tarea; imágenes y PDF se adjuntan desde el chat.`),
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
    const binary = /\.(png|jpe?g|gif|webp|pdf)$/i.test(file.name);
    if (file.size > (binary ? 1_000_000 : S.catalog.settings.max_file_bytes)) throw new Error(`El archivo supera ${binary ? 1000 : maxKb} KB.`);
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
      h("div", { class: "card-h spread" }, h("span", {}, t.name), h("span", { class: `pill ${RISK_CLASS[t.risk]}` }, RISK_SHORT[t.risk] || t.risk)),
      h("div", { class: "card-b stack" },
        h("p", {}, t.description),
        h("div", { class: "small" }, h("b", {}, "Nivel: "), t.risk_label),
        h("div", { class: "small" }, h("b", {}, "Permisos que requiere:"), h("ul", { class: "perm" }, t.permissions.map((p) => h("li", {}, p)))),
        t.requires_confirmation ? h("div", { class: "pill st-warn wrap" }, "! Pide confirmación antes de ejecutarse")
          : h("div", { class: "pill st-ok wrap" }, t.risk === "lectura_externa" ? "✓ Sin confirmación: solo lee tu servicio conectado" : "✓ Sin confirmación: solo dentro del proyecto"),
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
    const keyInput = h("input", { type: "password", autocomplete: "off", minlength: 8, maxlength: 500, placeholder: "Pega tu API key", spellcheck: "false", id: `key-${p.id}` });
    const source = p.key_source === "cuenta" ? "✓ Tu clave está guardada (cifrada, oculta)" : p.requires_key ? "No conectada" : "No necesita API key";
    return h("div", { class: "card" },
      h("div", { class: "card-h spread" }, h("span", {}, p.name), providerPill(p)),
      h("div", { class: "card-b stack" },
        h("p", {}, p.description),
        p.is_demo ? h("div", { class: "note small" }, "! No es una IA: respuestas fijas para probar la plataforma.") : null,
        h("div", { class: "small" }, h("b", {}, "Clave: "), source),
        h("div", { class: "small muted" }, p.key_help),
        h("div", { class: "small muted" }, "Última prueba: ", fmtDate(p.last_tested_at), " · último uso: ", fmtDate(p.last_used_at)),
        p.last_error ? h("div", { class: "alert small" }, "Último error: ", p.last_error) : null,
        p.requires_key ? h("form", { class: "row", novalidate: true, onsubmit: async (e) => {
          e.preventDefault();
          if (!validateForm(e.target)) return;
          try {
            await api("PUT", `/api/providers/${p.id}/key`, { api_key: keyInput.value.trim() });
            keyInput.value = "";
            const res = await api("POST", `/api/providers/${p.id}/test`);
            toast(res.ok ? `Clave guardada y verificada: ${res.message}` : `Clave guardada, pero la prueba falló: ${res.message}`, !res.ok);
            await refreshProviders(); renderProviders();
          } catch (err) { toast(err.message, true); }
        } }, h("label", { class: "sr", for: `key-${p.id}` }, `API key de ${p.name}`), h("div", { class: "grow" }, keyInput),
          h("button", { class: "btn small primary", type: "submit" }, p.key_source ? "Cambiar clave" : "Conectar")) : null,
        h("div", { class: "row" },
          p.key_source || !p.requires_key ? h("button", { class: "btn small", type: "button", onclick: (e) => withBusy(e.target, async () => {
            const res = await api("POST", `/api/providers/${p.id}/test`); toast(res.message, !res.ok); await refreshProviders(); renderProviders();
          }) }, "Probar conexión") : null,
          p.key_source ? h("button", { class: "btn small danger", type: "button", onclick: async (e) => {
            if (!await confirmDialog({ title: "Desconectar IA", danger: true, confirmLabel: "Borrar mi clave", body: `Tus proyectos que usan ${p.name} dejarán de funcionar hasta que conectes otra clave. Si ya no la usas, revócala también en el panel del proveedor.` })) return;
            await withBusy(e.target, async () => { await api("DELETE", `/api/providers/${p.id}/key`); toast("Clave borrada"); await refreshProviders(); renderProviders(); });
          } }, "Desconectar") : null)));
  }));
  renderProviders();

  const settings = S.catalog.settings;
  const limits = h("table", { class: "log" }, h("tbody", {}, [
    ["Tareas por minuto y usuario", settings.runs_per_minute_per_user],
    ["Timeout por llamada a la IA", `${settings.provider_timeout_seconds} s`], ["Reintentos ante errores temporales", settings.provider_max_retries],
    ["Tamaño máximo de archivo", fmtBytes(settings.max_file_bytes)], ["Duración de la sesión", `${settings.session_hours} h`],
    ["Registro abierto", settings.allow_signup ? "sí" : "no"],
  ].map(([k, v]) => h("tr", {}, h("th", { scope: "row" }, k), h("td", {}, String(v))))));

  const users = h("div", { class: "stack" });
  const loadUsers = async () => {
    const rows = await api("GET", "/api/auth/users");
    users.replaceChildren(h("p", { class: "small muted" }, `${rows.length} cuentas (últimas primero). Cada usuario solo ve sus propios proyectos, claves y conectores.`),
      h("div", { class: "table-wrap" }, h("table", { class: "log" }, h("thead", {}, h("tr", {}, ["Email", "Nombre", "Rol", "Alta"].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", {}, rows.map((u) => h("tr", {}, h("td", {}, u.email), h("td", {}, u.name), h("td", {}, u.role === "admin" ? "Administrador" : "Miembro"), h("td", { class: "num" }, fmtDate(u.created_at))))))));
  };

  const current = h("input", { type: "password", required: true, autocomplete: "current-password" });
  const next = h("input", { type: "password", required: true, minlength: 10, autocomplete: "new-password" });
  const pwForm = h("form", { novalidate: true, class: "stack" }, field("Contraseña actual", current), field("Nueva contraseña", next, "Mín. 10 caracteres. Cierra tus otras sesiones."),
    h("button", { class: "btn", type: "submit" }, "Cambiar contraseña"));
  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault(); if (!validateForm(pwForm)) return;
    try { await api("POST", "/api/auth/password", { current_password: current.value, new_password: next.value }); current.value = next.value = ""; toast("Contraseña cambiada"); }
    catch (err) { toast(err.message, true); }
  });
  const deleteAccount = h("button", { class: "btn danger", type: "button", onclick: async (e) => {
    if (!await confirmDialog({ title: "Eliminar mi cuenta", danger: true, confirmLabel: "Eliminar cuenta", typeToConfirm: S.user.email,
      body: "Se borrarán tus proyectos, historial, claves de IA y conectores. No se puede deshacer." })) return;
    await withBusy(e.target, async () => { await api("DELETE", "/api/auth/account?confirm=true"); S.user = null; location.hash = ""; boot(); });
  } }, "Eliminar mi cuenta");

  main.replaceChildren(h("div", { class: "stack" },
    h("h1", {}, "Ajustes"),
    h("h2", {}, "Mis IAs"),
    h("p", { class: "muted" }, "Conecta tus propias claves. Se guardan cifradas, nunca vuelven al navegador y solo se usan en tus proyectos y, si activas «Usar mi API», en Kairo. El consumo lo factura cada proveedor en tu cuenta."),
    providers,
    await aiPrefsCard(),
    await notifPrefsCard(),
    h("div", { class: "dash" },
      h("div", { class: "card" }, h("div", { class: "card-h" }, "Mi cuenta"), h("div", { class: "card-b stack" }, h("p", { class: "small" }, `${S.user.name} · ${S.user.email}`), pwForm,
        h("hr", { style: "border:none;border-top:2px dashed var(--soft)" }), deleteAccount)),
      h("div", { class: "card" }, h("div", { class: "card-h" }, "Límites de la plataforma"), h("div", { class: "card-b" }, limits))),
    isAdmin ? h("div", { class: "card" }, h("div", { class: "card-h" }, "Usuarios (admin)"), h("div", { class: "card-b" }, users)) : null));
  if (isAdmin) await loadUsers();
}


// ================================================================= PANEL (grafo)

const SVGNS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); kids.forEach((k) => el.append(k)); return el; };
const PROVIDER_COLOR = { anthropic: "naranja", openai: "verde", demo: "turquesa", "workers-ai": "azul" };
const CONNECTOR_COLOR = { github: "morado", discord_webhook: "azul", slack_webhook: "rosa" };
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (iso) => { if (!iso) return "—"; const d = new Date(iso); return `${pad2(d.getHours())}.${pad2(d.getMinutes())}`; };
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
function dur(r) {
  if (!r.started_at) return "—";
  const ms = new Date(r.finished_at || Date.now()) - new Date(r.started_at);
  return ms < 10000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}
function segbar(pct, n = 22, dark = false, live = false) {
  const on = Math.round((Math.max(0, Math.min(100, pct)) / 100) * n);
  return h("div", { class: "segbar" + (dark ? " dark" : "") + (live ? " live" : ""), role: "img", "aria-label": `${Math.round(pct)}%` },
    Array.from({ length: n }, (_, i) => h("i", { class: i < on ? (!dark && i === on - 1 && on < n ? "tip" : "on") : null, style: `--i:${i}` })));
}

// Recuerda valores anteriores para destellar solo lo que cambia.
const prevVals = new Map();
function val(key, v, style) {
  const changed = prevVals.has(key) && prevVals.get(key) !== String(v);
  prevVals.set(key, String(v));
  return h("b", { class: changed ? "flash" : null, style }, v);
}

const shortModel = (m) => String(m || "").replace(/^@cf\/[^/]+\//, "").replace(/-instruct.*$/, "").replace(/^claude-/, "claude ");
const linkKey = (prov, model) => `${prov}|${model}`;

/** Nodo de proyecto. compact = una sola línea (para 10, 20 o más proyectos). */
function projectNode(p, providers, compact) {
  const prov = providers.find((x) => x.id === p.provider);
  const k = p.id === "kairo" ? "kairo" : `p${p.id}`;
  const live = p.live > 0;
  const model = p.live_links?.[0]?.model || p.used?.[0]?.model || p.model;
  const provId = p.live_links?.[0]?.provider || p.used?.[0]?.provider || p.provider;
  const tasks = (p.runs || 0) + (p.kairo_runs || 0);
  const href = p.id === "kairo" ? "#/chat" : `#/p/${p.id}/overview`;
  const cls = "card node pnode" + (compact ? " compact" : "") + (live ? " live running" : "") + (p.active ? " active" : "");
  const head = h("div", { class: `node-h col-${p.color || "azul"}` }, h("span", { class: "title" }, p.id === "kairo" ? "kairo.chat" : slug(p.name) + ".proj"),
    live ? h("span", { class: "live-tag" }, "LIVE") : null);
  const chip = h("div", { class: "chip" }, h("i", { class: `col-${PROVIDER_COLOR[provId] || "azul"}` }), model ? shortModel(model) : "auto · Kairo");
  if (compact) {
    return h("a", { class: cls, href, "data-node": k, title: `${p.name}: ${tasks} tareas${live ? " · trabajando ahora" : ""}` },
      head, h("div", { class: "node-b" }, h("div", { class: "kv port" }, chip, val(`${k}.tasks`, tasks))));
  }
  return h("a", { class: cls, href, "data-node": k, "aria-label": `Proyecto ${p.name}: ${tasks} tareas${live ? ", trabajando ahora" : ""}` },
    head,
    h("div", { class: "node-b" },
      chip,
      h("div", { class: "kv port" }, "tareas", val(`${k}.runs`, tasks)),
      p.id === "kairo" ? null : h("div", { class: "kv port" }, "hoy", val(`${k}.today`, `${p.runs_today}/${p.limit_per_day}`)),
      p.failed ? h("div", { class: "kv port" }, "fallos", val(`${k}.failed`, p.failed, "color:var(--err)")) : h("div", { class: "kv port" }, "agentes", val(`${k}.ag`, live ? `${p.live_agents} trabajando` : "—")),
      p.id === "kairo" ? null : h("div", { class: "chk" + (p.status === "active" ? " on" : "") }, p.status === "archived" ? "archivado" : "activo"),
      p.provider && p.provider !== "demo" && (!prov || !prov.connected) ? h("div", { class: "small", style: "color:var(--warn);margin-top:4px" }, "! falta conectar la IA") : null));
}

/** Nodo de IA (proveedor + modelos en uso, cada modelo es un puerto) o de conector. */
function sideNode(kind, item, hotModels = new Set()) {
  const isProv = kind === "prov";
  const color = isProv ? PROVIDER_COLOR[item.id] || "azul" : CONNECTOR_COLOR[item.type] || "morado";
  const title = isProv ? `${item.id}.ia` : `${slug(item.name)}.${item.type.split("_")[0]}`;
  const platform = isProv && !item.connected;
  const ok = isProv ? item.connected || platform : item.status === "connected";
  const k = isProv ? `ia-${item.id}` : `c${item.id}`;
  const stateLabel = isProv ? (item.id === "workers-ai" ? "gratis" : platform ? "plataforma" : item.is_demo ? "demo" : item.connected ? (item.status === "ok" ? "verificada" : item.status === "error" ? "error" : "sin probar") : "sin clave")
    : ({ connected: "verificado", error: "error", untested: "sin probar", pending_config: "pendiente" })[item.status] || item.status;
  const models = isProv ? item.models || [] : [];
  const recv = isProv && models.some((m) => hotModels.has(linkKey(item.id, m.model)));
  return h("a", { class: "card node side" + (recv ? " recv" : ""), href: isProv ? "#/configuracion" : "#/conectores", "data-node": k,
    "aria-label": `${isProv ? "IA" : "Conector"} ${item.name}: ${stateLabel}${recv ? ", recibiendo datos" : ""}` },
    h("div", { class: `node-h col-${color}` }, h("span", { class: "title" }, title), recv ? h("span", { class: "live-tag" }, "RX") : null),
    h("div", { class: "node-b" },
      h("div", { class: "chk" + (ok ? " on" : "") }, isProv ? (item.connected ? "conectada" : "vía Kairo") : item.enabled ? "activo" : "inactivo",
        h("b", { class: "st-mini", style: !ok ? "color:var(--warn)" : null }, stateLabel)),
      models.length
        ? models.map((m) => h("div", { class: "kv port model" + (hotModels.has(linkKey(item.id, m.model)) ? " hot" : ""), "data-model": m.model, title: m.model },
          h("span", { class: "m-name" }, shortModel(m.model)), val(`${k}.${m.model}`, m.n ? `${m.n}×` : "—")))
        : h("div", { class: "kv port" }, "uso", val(`${k}.use`, item.last_used_at ? hhmm(item.last_used_at) : "—"))));
}

// Dibuja los cables. Capa base (detrás) + capa de enlaces vivos (encima del bus, debajo de las tarjetas).
// Solo se redibuja si cambia la estructura, así las animaciones no saltan.
let wireSig = "";
function drawWires(map, data, force = false) {
  const box = map.getBoundingClientRect();
  const busEl = map.querySelector(".bus");
  const bus = busEl?.getBoundingClientRect();
  const clear = () => { map.querySelectorAll("svg.wires").forEach((x) => x.remove()); wireSig = ""; };
  if (!bus || !box.width || getComputedStyle(map).gridTemplateColumns.split(" ").length < 3) return clear();
  const pp = PREFS.data.panel || {};
  const nodes = [...map.querySelectorAll("[data-node]")];
  const links = data.links || [];
  const sig = `${Math.round(box.width)}x${Math.round(box.height)}|${nodes.map((n) => n.dataset.node + ":" + Math.round(n.getBoundingClientRect().top - box.top)).join(",")}|${links.map((l) => l.from + ">" + l.key + (l.hot ? "*" : "")).join(",")}|${pp.tangle}${pp.particles}`;
  if (!force && sig === wireSig && map.querySelector("svg.wires")) return;
  wireSig = sig;
  map.querySelectorAll("svg.wires").forEach((x) => x.remove());

  const base = svg("svg", { class: "wires base", "aria-hidden": "true" });
  const top = svg("svg", { class: "wires fx", "aria-hidden": "true" });
  top.append(svg("defs", {}, svg("filter", { id: "glowblur", x: "-20%", y: "-20%", width: "140%", height: "140%" }, svg("feGaussianBlur", { stdDeviation: "5" }))));
  const gFaint = svg("g", { class: "g-faint" }), gMain = svg("g", { class: "g-main" });
  base.append(gFaint, gMain);
  const gLink = svg("g", { class: "g-link" }), gHalo = svg("g", { class: "g-halo", filter: "url(#glowblur)" }), gHot = svg("g", { class: "g-hot" }), gFx = svg("g", { class: "g-fx" });
  top.append(gLink, gHalo, gHot, gFx);

  const bx1 = bus.left - box.left, bx2 = bus.right - box.left, bTop = bus.top - box.top + 24, bH = Math.max(40, bus.height - 48);
  let seed = 11;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  let pid = 0, edges = 0;
  const curve = (x1, y1, x2, y2, bend = 0.5) => {
    const mx = x1 + (x2 - x1) * bend;
    return `M${x1.toFixed(1)},${y1.toFixed(1)} C${mx.toFixed(1)},${y1.toFixed(1)} ${mx.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  };
  const particles = !REDUCED && pp.particles !== false;
  const particle = (g, d, durS, delay, cls, reverse = false) => {
    if (!particles) return;
    const id = `w${pid++}`;
    g.append(svg("path", { id, d, class: "wire-ghost" }));
    const motion = { dur: `${durS}s`, begin: `${delay}s`, repeatCount: "indefinite", rotate: "auto" };
    if (reverse) Object.assign(motion, { keyPoints: "1;0", keyTimes: "0;1", calcMode: "linear" });
    g.append(svg("circle", { r: cls.includes("hot") ? 3.2 : 2, class: `spark ${cls}` }, svg("animateMotion", motion, svg("mpath", { href: `#${id}` }))));
  };
  const portsOf = (n) => {
    const r = n.getBoundingClientRect();
    const ports = [...n.querySelectorAll(".kv.port")];
    return { r, ports: ports.length ? ports.map((p) => ({ el: p, y: p.getBoundingClientRect().top + p.getBoundingClientRect().height / 2 - box.top })) : [{ el: n, y: r.top + r.height / 2 - box.top }] };
  };
  const busY = (key, i) => bTop + ((([...key].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) + i * 53) % 1000) / 1000) * bH;

  // 1) Cables base: cada puerto se conecta al bus compartido.
  const anchors = new Map(); // data-node -> { x, y, left } del puerto principal
  const modelPorts = new Map(); // "prov|model" -> { x, y }
  nodes.forEach((n) => {
    const { r, ports } = portsOf(n);
    const left = r.left + r.width / 2 < bus.left + bus.width / 2;
    const key = n.dataset.node;
    const x = left ? r.right - box.left + 5 : r.left - box.left - 5;
    const bx = left ? bx1 : bx2;
    anchors.set(key, { x, y: ports[0].y, left });
    if (pp.tangle !== false) {
      for (let k = 0; k < (nodes.length > 14 ? 3 : 7); k++) {
        const y1 = ports[k % ports.length].y + (rnd() - 0.5) * 6;
        const far = left ? bx2 + rnd() * 60 : bx1 - rnd() * 60;
        gFaint.append(svg("path", { d: curve(x, y1, k % 4 === 0 ? far : bx, bTop + rnd() * bH, 0.35 + rnd() * 0.4), class: "wire faint", style: `--d:${(rnd() * 4).toFixed(2)}s` }));
      }
    }
    ports.forEach((p, i) => {
      if (p.el.dataset?.model) modelPorts.set(linkKey(key.replace(/^ia-/, ""), p.el.dataset.model), { x, y: p.y });
      const d = curve(x, p.y, bx, busY(key, i));
      edges++;
      gMain.append(svg("path", { d, class: "wire" }));
      if (rnd() < (nodes.length > 14 ? 0.15 : 0.35)) particle(gMain, d, 4 + rnd() * 4, -rnd() * 6, "");
      gMain.append(svg("circle", { cx: bx, cy: busY(key, i), r: 2.2, class: "jn" }));
      gMain.append(svg("circle", { cx: x, cy: p.y, r: 1.6, class: "jn port-glow" }));
    });
  });

  // 2) Enlaces reales proyecto → bus → modelo de IA. Encendidos cuando se están usando.
  for (const l of links) {
    const a = anchors.get(l.from);
    const b = modelPorts.get(l.key);
    if (!a) continue;
    const ya = busY(l.from, 99), yb = b ? b.y + (busY(l.key, 7) - b.y) * 0.15 : ya;
    const d = b
      ? `${curve(a.x, a.y, bx1, ya)} C${(bx1 + (bx2 - bx1) * 0.6).toFixed(1)},${ya.toFixed(1)} ${(bx1 + (bx2 - bx1) * 0.4).toFixed(1)},${yb.toFixed(1)} ${bx2.toFixed(1)},${yb.toFixed(1)} ${curve(bx2, yb, b.x, b.y).replace(/^M[^C]+/, "")}`
      : curve(a.x, a.y, bx1, ya);
    if (!l.hot) { gLink.append(svg("path", { d, class: "wire link" })); continue; }
    edges++;
    gHalo.append(svg("path", { d, class: "wire halo" }));
    gHot.append(svg("path", { d, class: "wire hot" }));
    gHot.append(svg("path", { d, class: "wire core" }));
    for (let i = 0; i < 3; i++) particle(gFx, d, 2.2, -i * 0.73, "hot");
    for (let i = 0; i < 2; i++) particle(gFx, d, 2.8, -i * 1.4, "hot back", true);
    gFx.append(svg("circle", { cx: a.x, cy: a.y, r: 4, class: "jn pulse" }));
    if (b) gFx.append(svg("circle", { cx: b.x, cy: b.y, r: 4, class: "jn pulse rx" }));
    gFx.append(svg("circle", { cx: bx1, cy: ya, r: 3.4, class: "jn pulse" }));
  }
  map.dataset.edges = edges;
  map.prepend(base);
  map.append(top);
}

// Contadores vivos de la cabecera (T y FRAME), como en el vídeo.
function startClock(tEl, fEl) {
  const t0 = performance.now();
  let frame = 0, last = 0, alive = true;
  const tick = (now) => {
    if (!alive || !tEl.isConnected) return;
    frame++;
    if (now - last > 90) {
      last = now;
      const secs = (now - t0) / 1000;
      tEl.textContent = `${pad2(Math.floor(secs / 60) % 100)}.${pad2(Math.floor(secs % 60))}`;
      fEl.textContent = String(frame % 10000).padStart(4, "0");
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => { alive = false; };
}

let panelFirst = true;
async function viewPanel(main) {
  const map = h("section", { class: "map" + (panelFirst ? " intro" : ""), "aria-label": "Mapa de proyectos, IAs y conectores" });
  const runlog = h("div", { class: "rlog", role: "list" });
  const dispatch = h("div", {});
  const stats = h("div", { class: "statlist" });
  const workers = h("span", { class: "pill tag-dark" }, "—");
  const foot = h("div", { class: "metrics-foot" });
  const fleet = h("div", {});
  const bar = h("div", { class: "map-bar" });
  const custom = h("div", { class: "map-custom card", hidden: true });
  main.replaceChildren(h("div", { class: "panel-view" },
    bar, custom, map, fleet,
    h("div", { class: "panels" },
      h("section", { class: "card panel-card", style: "--k:0" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, "Run log"), h("span", { class: "live" }, "LIVE")), h("div", { class: "card-b" }, runlog)),
      h("section", { class: "card panel-card", style: "--k:1" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, "Dispatch"), workers), h("div", { class: "card-b" }, dispatch)),
      h("section", { class: "card panel-card", style: "--k:2" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, "Graph stats"), h("span", { class: "pill tag-blue" }, "v2.0")), h("div", { class: "card-b" }, stats))),
    foot));
  if (panelFirst) setTimeout(() => map.classList.remove("intro"), 3200);
  panelFirst = false;

  let data = null;
  const seenRuns = new Set();
  let firstPaint = true;
  const pp = () => PREFS.data.panel || {};
  const savePanel = (patch) => { setPrefs({ panel: patch }); render(); requestAnimationFrame(() => drawWires(map, data, true)); };
  const seg = (label, options, cur, onPick) => h("div", { class: "seg-field" }, h("label", {}, label),
    h("div", { class: "segctl" }, options.map(([id, l]) => h("button", { type: "button", "aria-selected": cur === id ? "true" : "false", onclick: () => onPick(id) }, l))));
  const toggle = (label, value, onChange) => {
    const cb = h("input", { type: "checkbox", checked: value ? true : null });
    cb.addEventListener("change", () => onChange(cb.checked));
    return h("label", { class: "switch" }, cb, label);
  };
  const renderCustom = () => {
    const P = pp(), hidden = new Set(P.hidden || []);
    custom.replaceChildren(
      h("div", { class: "card-h spread" }, h("span", { class: "grow" }, "Personalizar la red"), h("button", { class: "btn small ghost", type: "button", onclick: () => { custom.hidden = true; } }, icon("close", 16))),
      h("div", { class: "card-b map-custom-b" },
        h("div", { class: "stack" },
          seg("Tamaño de los nodos", [["auto", "Auto"], ["compact", "Compacto"], ["full", "Completo"]], P.size || "auto", (x) => { savePanel({ size: x }); renderCustom(); }),
          seg("Ordenar proyectos", [["recent", "Recientes"], ["activity", "Actividad"], ["name", "Nombre"]], P.sort || "recent", (x) => { savePanel({ sort: x }); renderCustom(); }),
          h("div", { class: "toggle-grid" },
            toggle("Mostrar conectores", P.connectors !== false, (x) => savePanel({ connectors: x })),
            toggle("Mostrar archivados", !!P.archived, (x) => savePanel({ archived: x })),
            toggle("Cables de fondo", P.tangle !== false, (x) => savePanel({ tangle: x })),
            toggle("Partículas de datos", P.particles !== false, (x) => savePanel({ particles: x })))),
        h("div", {},
          h("div", { class: "row spread" }, h("label", { style: "margin:0" }, "Proyectos visibles"),
            h("span", { class: "row" },
              h("button", { class: "btn small ghost", type: "button", onclick: () => { savePanel({ hidden: [] }); renderCustom(); } }, "Todos"),
              h("button", { class: "btn small ghost", type: "button", onclick: () => { savePanel({ hidden: data.projects.map((p) => p.id) }); renderCustom(); } }, "Ninguno"))),
          h("div", { class: "vis-list" }, data.projects.map((p) => toggle(p.name, !hidden.has(p.id), (on) => {
            const next = new Set(pp().hidden || []); on ? next.delete(p.id) : next.add(p.id); savePanel({ hidden: [...next] });
          }))))));
  };

  const render = () => {
    const P = pp(), hidden = new Set(P.hidden || []);
    let projects = data.projects.filter((p) => !hidden.has(p.id) && (P.archived || p.status !== "archived"));
    if (P.sort === "name") projects = [...projects].sort((a, b) => a.name.localeCompare(b.name));
    else if (P.sort === "activity") projects = [...projects].sort((a, b) => (b.live - a.live) || (b.active - a.active) || ((b.runs + b.kairo_runs) - (a.runs + a.kairo_runs)));
    const kairo = data.kairo && (data.kairo.runs || data.kairo.live) ? { id: "kairo", name: "Kairo", color: "azul", status: "active", runs: 0, kairo_runs: data.kairo.runs, runs_today: 0, limit_per_day: 0, failed: 0, active: data.kairo.live, ...data.kairo } : null;
    const nodesData = kairo ? [kairo, ...projects] : projects;
    // IAs conectadas por el usuario + las que Kairo ha usado con la clave de la plataforma.
    const providers = data.providers.filter((p) => p.connected || (p.models || []).some((m) => m.n > 0));
    // Enlaces reales: qué modelo usa cada proyecto (encendido si se usa ahora mismo).
    const links = [];
    const hotModels = new Set();
    for (const p of nodesData) {
      const from = p.id === "kairo" ? "kairo" : `p${p.id}`;
      const hot = new Set((p.live_links || []).map((l) => linkKey(l.provider, l.model)));
      hot.forEach((k) => hotModels.add(k));
      const keys = new Set([...hot, ...(p.used || []).map((u) => linkKey(u.provider, u.model)), ...(p.provider && p.model ? [linkKey(p.provider, p.model)] : [])]);
      for (const key of keys) links.push({ from, key, hot: hot.has(key) });
      if (p.live > 0 && !hot.size) links.push({ from, key: "__bus", hot: true });
    }
    data.links = links;
    const compact = P.size === "compact" || (P.size !== "full" && nodesData.length > 6);
    const left = nodesData.map((p) => projectNode(p, data.providers, compact));
    const side = [...providers.map((p) => sideNode("prov", p, hotModels)), ...(P.connectors === false ? [] : data.connectors.map((c) => sideNode("conn", c)))];
    if (!nodesData.length) left.push(h("a", { class: "card node", href: "#/proyectos", "data-node": "new" },
      h("div", { class: "node-h col-azul" }, h("span", { class: "title" }, data.projects.length ? "ocultos.proj" : "nuevo.proj")),
      h("div", { class: "node-b" }, h("div", { class: "chk" }, data.projects.length ? "todos ocultos" : "sin proyectos todavía"), h("div", { class: "kv port" }, "siguiente", h("b", {}, data.projects.length ? "personalizar" : "crear →")))));
    [...left, ...side].forEach((n, i) => n.style.setProperty("--k", i));
    const running = nodesData.some((p) => p.live > 0 || p.running);
    const cols = nodesData.length > 18 ? 3 : nodesData.length > 7 ? 2 : 1;
    map.style.setProperty("--pcols", cols);
    map.classList.toggle("dense", cols > 1);
    // Se conservan los SVG de cables para que sus animaciones no se reinicien.
    [...map.children].forEach((ch) => { if (!ch.matches("svg.wires")) ch.remove(); });
    map.append(
      h("div", { class: "col left" + (compact ? " compact" : "") }, left),
      h("div", { class: "bus" + (running ? " running" : ""), "aria-hidden": "true" },
        h("div", { class: "sheen" }), h("div", { class: "handle" }),
        h("span", { class: "label" }, running ? "shared surface · live" : "shared surface · locked")),
      h("div", { class: "col right" }, side));
    const liveN = nodesData.filter((p) => p.live > 0).length;
    bar.replaceChildren(
      h("div", { class: "map-title" }, h("span", { class: "eyebrow" }, "Control IA · red global"),
        h("b", {}, `${projects.length} proyecto${projects.length === 1 ? "" : "s"}${kairo ? " + Kairo" : ""} · ${providers.length} IA${providers.length === 1 ? "" : "s"} · ${hotModels.size || 0} modelo${hotModels.size === 1 ? "" : "s"} en uso`)),
      liveN ? h("span", { class: "live" }, `${liveN} TRABAJANDO`) : h("span", { class: "pill tag-dark" }, "en espera"),
      h("button", { class: "btn small", type: "button", "aria-expanded": String(!custom.hidden), onclick: (e) => { custom.hidden = !custom.hidden; e.currentTarget.setAttribute("aria-expanded", String(!custom.hidden)); if (!custom.hidden) renderCustom(); } },
        icon("sliders", 16), " Personalizar"));
    requestAnimationFrame(() => drawWires(map, data));

    runlog.replaceChildren(...(data.runs.length ? data.runs.map((r, i) => {
      const fresh = !firstPaint && !seenRuns.has(r.id);
      seenRuns.add(r.id);
      return h("div", { role: "listitem", class: "rl-row" + (fresh ? " fresh" : "") + (i === 0 ? " cur" : "") },
        h("span", { class: "t" }, hhmm(r.created_at)),
        h("a", { class: "a", href: `#/proyectos/${r.project_id}/ejecuciones` }, slug(r.project_name)),
        h("span", { class: "f" }, trunc(r.input, 40)),
        h("span", { class: "ms" }, dur(r)),
        h("span", {}, h("span", { class: `pill ${RUN_STATUS[r.status]?.[1] || "st-idle"}` }, SHORT[r.status] || r.status)));
    }) : [h("p", { class: "small muted", style: "grid-column:1/-1" }, "Sin tareas todavía. Lanza una desde un proyecto.")]));

    workers.textContent = `${projects.length} workers`;
    dispatch.replaceChildren(
      ...(projects.length ? projects.slice(0, 8).map((p, i) => {
        const pct = p.limit_per_day ? (p.runs_today / p.limit_per_day) * 100 : 0;
        const state = p.running ? ["run", "st-ok"] : p.active ? ["wait", "st-warn"] : ["idle", "st-idle"];
        return h("div", { class: "dispatch-row", title: `${p.name}: ${p.runs_today} de ${p.limit_per_day} tareas hoy` },
          h("span", {}, `w${i + 1}`), segbar(Math.max(pct, p.running ? 8 : 0), 22, false, p.running > 0),
          val(`d${p.id}`, `${Math.round(pct)}%`), h("span", {}, h("span", { class: `pill ${state[1]}` }, state[0])));
      }) : [h("p", { class: "small muted" }, "Crea un proyecto para ver su carga diaria.")]),
      h("div", { class: "dispatch-foot" },
        h("span", {}, "parallel ", val("t.active", data.totals.active)),
        h("span", {}, "queued ", val("t.pa", data.totals.pending_actions)),
        h("span", {}, "steps ", val("t.steps", data.totals.steps))));

    const t = data.totals;
    const done = (t.completed || 0) + (t.failed || 0);
    const rate = done ? ((t.completed || 0) / done) * 100 : 0;
    const buckets = Array(48).fill(0);
    const now = Date.now();
    for (const b of data.hourly) {
      const idx = 47 - Math.floor((now - new Date(b.h + ":00:00Z").getTime()) / 1800_000);
      if (idx >= 0 && idx < 48) buckets[idx] += b.n;
    }
    // Ruido suave para que la línea "respire" aunque no haya actividad.
    const max = Math.max(1, ...buckets);
    const pts = buckets.map((v, i) => `${((i / 47) * 300).toFixed(1)},${(36 - (v / max) * 28 - (Math.sin(i * 1.7 + now / 900) + 1) * 1.6).toFixed(1)}`).join(" L");
    const sp = svg("svg", { class: "spark" + (firstPaint ? " draw" : ""), viewBox: "0 0 300 42", preserveAspectRatio: "none", role: "img", "aria-label": "Actividad de las últimas 24 h" },
      svg("path", { d: `M${pts}` }));
    stats.replaceChildren(
      h("div", { class: "kv" }, "edges", val("s.edges", map.dataset.edges || 0)),
      h("div", { class: "kv" }, "bus readers", val("s.br", providers.length + data.connectors.length)),
      h("div", { class: "kv" }, "proyectos", val("s.p", projects.length)),
      h("div", { class: "kv" }, "runs", val("s.r", t.runs)),
      h("div", { class: "kv" }, "tokens hoy", val("s.tok", t.tokens_today.toLocaleString("es-ES"))),
      h("div", { class: "kv blue" }, "strikes", val("s.f", t.failed || 0)),
      h("div", { class: "kv", style: "border-top:1.5px solid var(--soft);margin-top:6px;padding-top:8px" }, "éxito", val("s.rate", `${Math.round(rate)}%`)),
      segbar(rate, 26, true),
      sp);

    const files = projects.reduce((a, p) => a + (p.files || 0), 0);
    foot.replaceChildren(h("span", {}, `shared surface · ${files} files · ${t.active ? "live current" : "idle"}`), h("b", {}, `@${slug(S.user.name).replace(/-/g, "_")}`));
    S.dash = { files, edges: Number(map.dataset.edges || 0), readers: providers.length + data.connectors.length, active: t.active };
    firstPaint = false;
  };

  let fleetSig = "";
  const load = async () => {
    data = await api("GET", "/api/dashboard"); S.projects = data.projects; render();
    const sig = JSON.stringify(data.agent_runs);
    if (sig !== fleetSig) { fleetSig = sig; fleet.replaceChildren(agentFleet(data.agent_runs)); }
  };
  await load();
  every(3000, load);
  // Redibuja al cambiar el tamaño (ventana, menú lateral plegado…).
  let rt = null;
  const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (!map.isConnected) return ro.disconnect(); if (data) drawWires(map, data); }, 140); });
  ro.observe(map);
}
