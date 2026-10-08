/* Centro de notificaciones: campana en la cabecera, vista completa con filtros,
 * leídas/no leídas, enlaces profundos, preferencias por categoría y avisos del
 * navegador (Notification API) cuando la web está abierta en segundo plano. */
"use strict";

const NOTIF_CAT = {
  ia: ["IA", "spark", "#3d7cff"], sistema: ["Sistema", "cpu", "#6b7079"], seguridad: ["Seguridad", "shield", "#ea3b4b"],
  cuenta: ["Cuenta", "user", "#22c1ad"], suscripcion: ["Suscripción", "star", "#f6a33c"], alertas: ["Alertas", "bell", "#a97cf2"],
};
const NOTIF = { lastSeenId: Number(localStorageGet("kx-last-notif") || 0), prefs: null };

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "ahora";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return fmtDate(iso);
}

function notifItem(n, onChange) {
  const [label, ic, color] = NOTIF_CAT[n.category] || NOTIF_CAT.sistema;
  const open = async () => {
    if (!n.read_at) { await api("POST", `/api/notifications/${n.id}/read`).catch(() => {}); n.read_at = new Date().toISOString(); onChange?.(); }
    if (n.link) location.hash = n.link;
  };
  return h("div", { class: "nt-item" + (n.read_at ? "" : " unread") + (n.priority === "high" ? " high" : ""), style: `--c:${color}` },
    h("span", { class: "nt-ico" }, icon(ic, 16)),
    h("button", { class: "nt-body", type: "button", onclick: open },
      h("span", { class: "nt-title" }, n.title),
      n.body ? h("span", { class: "nt-text" }, n.body) : null,
      h("span", { class: "nt-meta" }, label, " · ", ago(n.created_at))),
    h("button", { class: "nt-x", type: "button", "aria-label": "Eliminar notificación", onclick: async () => { await api("DELETE", `/api/notifications/${n.id}`); onChange?.(true); } }, icon("close", 14)));
}

/** Campana de la cabecera con contador y desplegable. */
function notifBell() {
  const badge = h("span", { class: "nt-badge", hidden: true });
  const pop = h("div", { class: "nt-pop", hidden: true, role: "dialog", "aria-label": "Notificaciones" });
  const btn = h("button", { class: "icon-btn", type: "button", "aria-label": "Notificaciones", "aria-haspopup": "dialog" }, icon("bell", 19), badge);
  const wrap = h("div", { class: "nt-wrap" }, btn, pop);
  const loadPop = async () => {
    const rows = await api("GET", "/api/notifications");
    pop.replaceChildren(
      h("div", { class: "nt-pop-head" }, h("b", {}, "Notificaciones"),
        h("button", { class: "btn small ghost", type: "button", onclick: async () => { await api("POST", "/api/notifications/read-all", {}); refresh(); loadPop(); } }, "Marcar todo leído")),
      h("div", { class: "nt-pop-list" }, rows.length ? rows.slice(0, 8).map((n) => notifItem(n, () => { refresh(); loadPop(); })) : h("p", { class: "small muted", style: "padding:14px" }, "No tienes notificaciones.")),
      h("a", { class: "nt-pop-foot", href: "#/notificaciones", onclick: () => { pop.hidden = true; } }, "Ver todas y preferencias"));
  };
  btn.addEventListener("click", async (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) await loadPop(); });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) pop.hidden = true; });
  const refresh = async () => {
    const s = await api("GET", "/api/notifications/summary");
    badge.hidden = !s.unread;
    badge.textContent = s.unread > 9 ? "9+" : s.unread;
    btn.setAttribute("aria-label", s.unread ? `Notificaciones: ${s.unread} sin leer` : "Notificaciones");
    // Aviso del navegador solo si la pestaña está en segundo plano y el usuario lo activó.
    if (s.latest && s.latest.id > NOTIF.lastSeenId) {
      if (NOTIF.lastSeenId && document.hidden) browserNotify(s.latest);
      NOTIF.lastSeenId = s.latest.id; localStorageSet("kx-last-notif", String(s.latest.id));
    }
  };
  refresh().catch(() => {});
  every(30_000, refresh); // ligero: un recuento cada 30 s
  return wrap;
}

async function browserNotify(n) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!NOTIF.prefs) NOTIF.prefs = await api("GET", "/api/notifications/prefs").catch(() => []);
  const pref = NOTIF.prefs.find((p) => p.id === n.category);
  if (!pref || !pref.browser) return;
  const note = new Notification(`${BRAND_NAME} · ${n.title}`, { body: n.body || "", tag: `kx-${n.id}`, icon: "/favicon.svg" });
  note.onclick = () => { window.focus(); if (n.link) location.hash = n.link; note.close(); };
}

async function viewNotifications(main) {
  const state = { category: "", unread: false };
  const list = h("div", { class: "nt-list" });
  const chips = h("div", { class: "chips" });
  const load = async () => {
    const qs = new URLSearchParams({ ...(state.category ? { category: state.category } : {}), ...(state.unread ? { unread: "1" } : {}) });
    const [rows, sum] = await Promise.all([api("GET", `/api/notifications?${qs}`), api("GET", "/api/notifications/summary")]);
    chips.replaceChildren(
      h("button", { type: "button", class: "chip-btn", "aria-pressed": state.category ? "false" : "true", onclick: () => { state.category = ""; load(); } }, "Todas", sum.unread ? h("b", {}, sum.unread) : null),
      ...Object.entries(NOTIF_CAT).map(([id, [label, ic]]) => h("button", { type: "button", class: "chip-btn", "aria-pressed": state.category === id ? "true" : "false", onclick: () => { state.category = id; load(); } },
        icon(ic, 14), label, sum.by_category[id] ? h("b", {}, sum.by_category[id]) : null)));
    list.replaceChildren(...(rows.length ? rows.map((n) => notifItem(n, () => load())) : [empty("Todo al día", state.unread ? "No tienes notificaciones sin leer." : "Aquí verás avisos de Kairo, tu cuenta, seguridad y suscripción.")]));
  };
  const unreadToggle = h("input", { type: "checkbox" });
  unreadToggle.addEventListener("change", () => { state.unread = unreadToggle.checked; load(); });
  main.replaceChildren(h("div", { class: "stack" },
    h("div", { class: "page-head" }, h("div", {}, h("div", { class: "mono-up" }, "Centro de notificaciones"), h("h1", {}, "Notificaciones")),
      h("div", { class: "row" }, h("label", { class: "switch small" }, unreadToggle, "Solo sin leer"),
        h("button", { class: "btn small", type: "button", onclick: async () => { await api("POST", "/api/notifications/read-all", state.category ? { category: state.category } : {}); load(); } }, icon("check", 15), "Marcar leídas"))),
    chips,
    h("section", { class: "card" }, list),
    await notifPrefsCard()));
  await load();
}

async function notifPrefsCard() {
  const prefs = await api("GET", "/api/notifications/prefs");
  NOTIF.prefs = prefs;
  const save = async () => { await api("PUT", "/api/notifications/prefs", { prefs }); toast("Preferencias guardadas"); };
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const permBtn = perm === "default" ? h("button", { class: "btn small", type: "button", onclick: async () => {
    const r = await Notification.requestPermission(); toast(r === "granted" ? "Avisos del navegador activados" : "El navegador no dio permiso", r !== "granted"); } }, "Permitir avisos del navegador")
    : h("span", { class: "small muted" }, perm === "granted" ? "Avisos del navegador permitidos." : perm === "denied" ? "El navegador tiene los avisos bloqueados para esta web." : "Tu navegador no admite avisos.");
  return h("section", { class: "card" }, h("div", { class: "card-h" }, "Preferencias de notificaciones"),
    h("div", { class: "card-b stack" },
      h("p", { class: "small muted" }, "Elige qué avisos quieres ver. Los de seguridad no se pueden desactivar. Para evitar spam, los avisos repetidos se agrupan y hay un máximo por hora."),
      h("table", { class: "log prefs" }, h("thead", {}, h("tr", {}, h("th", {}, "Categoría"), h("th", {}, "En la web"), h("th", {}, "Navegador"))),
        h("tbody", {}, prefs.map((p) => {
          const [label, ic] = NOTIF_CAT[p.id] || [p.label, "bell"];
          const a = h("input", { type: "checkbox", checked: p.in_app ? true : null, disabled: p.locked ? true : null, "aria-label": `${label} en la web` });
          const b = h("input", { type: "checkbox", checked: p.browser ? true : null, "aria-label": `${label} en el navegador` });
          a.addEventListener("change", () => { p.in_app = a.checked; save(); });
          b.addEventListener("change", () => { p.browser = b.checked; save(); });
          return h("tr", {}, h("td", {}, h("span", { class: "row", style: "gap:8px" }, icon(ic, 15), label)), h("td", {}, a), h("td", {}, b));
        }))),
      permBtn));
}
