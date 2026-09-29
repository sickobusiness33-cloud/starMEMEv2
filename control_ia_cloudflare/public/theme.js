/* Sistema de diseño de Control IA: tokens, temas, personalización y preferencias.
 *
 * Todas las superficies de la interfaz leen variables CSS (--th-*). Un tema es
 * solo un conjunto de valores para esas variables: añadir uno nuevo = añadir un
 * objeto a THEMES. Las preferencias se guardan en el servidor (/api/workspace/prefs)
 * y en localStorage como copia rápida para el primer pintado.
 */
"use strict";

const THEME_TOKENS = [
  ["bg", "Fondo"], ["panel", "Paneles"], ["card", "Tarjetas"], ["border", "Bordes"], ["text", "Texto"], ["muted", "Texto secundario"],
  ["primary", "Color principal"], ["secondary", "Color secundario"], ["btn", "Botones"], ["btnText", "Texto de botones"],
  ["badge", "Badges"], ["label", "Etiquetas"], ["node", "Nodos de agentes"], ["conn", "Conexiones"], ["robot", "Brillo de robots"],
  ["ok", "Estado: completado"], ["run", "Estado: trabajando"], ["warn", "Estado: esperando"], ["err", "Estado: error"],
];

const BASE_DARK = { bg: "#05080a", panel: "#0a0f12", card: "#0e1418", border: "#1b262c", text: "#e7f2ee", muted: "#8b9c96", btnText: "#03130c", badge: "#12201b", ok: "#34f5a4", warn: "#fbbf24", err: "#fb4d6d" };

const THEMES = {
  cyber: { title: "Cyber", ...BASE_DARK, primary: "#34f5a4", secondary: "#22d3ee", btn: "#34f5a4", label: "#7ff0c4", node: "#34f5a4", conn: "#34f5a4", robot: "#34f5a4", run: "#22d3ee" },
  emerald: { title: "Emerald", ...BASE_DARK, primary: "#10b981", secondary: "#a3e635", btn: "#10b981", label: "#6ee7b7", node: "#10b981", conn: "#34d399", robot: "#10b981", run: "#a3e635", ok: "#10b981" },
  purple: { title: "Purple", ...BASE_DARK, bg: "#07050c", panel: "#0d0a14", card: "#130f1c", border: "#241d33", text: "#efeaf8", muted: "#9d93b3", badge: "#1c1530", primary: "#a78bfa", secondary: "#f472b6", btn: "#a78bfa", btnText: "#140a26", label: "#c4b5fd", node: "#a78bfa", conn: "#c084fc", robot: "#a78bfa", run: "#f472b6" },
  blue: { title: "Blue", ...BASE_DARK, bg: "#04070d", panel: "#081019", card: "#0c1622", border: "#1a2838", text: "#e8f0fb", muted: "#8ea0b8", badge: "#10203a", primary: "#3b82f6", secondary: "#22d3ee", btn: "#3b82f6", btnText: "#ffffff", label: "#93c5fd", node: "#3b82f6", conn: "#60a5fa", robot: "#3b82f6", run: "#22d3ee" },
  red: { title: "Red", ...BASE_DARK, bg: "#0a0506", panel: "#120a0c", card: "#180e11", border: "#2c1a1e", text: "#f8ecee", muted: "#b0959a", badge: "#2a1116", primary: "#f43f5e", secondary: "#fb923c", btn: "#f43f5e", btnText: "#ffffff", label: "#fda4af", node: "#f43f5e", conn: "#fb7185", robot: "#f43f5e", run: "#fb923c", err: "#ff2d55" },
  amber: { title: "Amber", ...BASE_DARK, bg: "#090704", panel: "#110d07", card: "#17120a", border: "#2b2214", text: "#f7f0e4", muted: "#ab9d86", badge: "#241b0c", primary: "#f59e0b", secondary: "#fde047", btn: "#f59e0b", btnText: "#1a1002", label: "#fcd34d", node: "#f59e0b", conn: "#fbbf24", robot: "#f59e0b", run: "#fde047" },
  ice: { title: "Ice", ...BASE_DARK, bg: "#050809", panel: "#0a1013", card: "#0f171b", border: "#1d2a30", text: "#eef8fb", muted: "#94aab2", badge: "#11232a", primary: "#67e8f9", secondary: "#c4b5fd", btn: "#67e8f9", btnText: "#021417", label: "#a5f3fc", node: "#67e8f9", conn: "#a5f3fc", robot: "#67e8f9", run: "#c4b5fd" },
  white: { title: "White", bg: "#ffffff", panel: "#f6f7f9", card: "#ffffff", border: "#e2e6ec", text: "#0f172a", muted: "#5b6576", badge: "#eef2f7", primary: "#2563eb", secondary: "#db2777", btn: "#2563eb", btnText: "#ffffff", label: "#1d4ed8", node: "#2563eb", conn: "#7c3aed", robot: "#2563eb", ok: "#16a34a", run: "#0891b2", warn: "#d97706", err: "#dc2626" },
  mono: { title: "Mono", ...BASE_DARK, bg: "#060606", panel: "#0c0c0c", card: "#121212", border: "#252525", text: "#f2f2f2", muted: "#9a9a9a", badge: "#1c1c1c", primary: "#f2f2f2", secondary: "#9a9a9a", btn: "#f2f2f2", btnText: "#0a0a0a", label: "#d4d4d4", node: "#e5e5e5", conn: "#a3a3a3", robot: "#f2f2f2", run: "#d4d4d4", ok: "#e5e5e5" },
};

const DEFAULT_MODULES = [
  ["agents", "Agentes de IA", true], ["projects", "Proyectos recientes", true], ["activity", "Actividad", true], ["tasks", "Tareas", true],
  ["usage", "Uso", true], ["analytics", "Analíticas", false], ["system", "Estado del sistema", false], ["files", "Archivos recientes", false],
  ["providers", "Proveedores de IA", false],
];

const DEFAULT_PREFS = {
  theme: { preset: "cyber", custom: {}, glow: 0.6, radius: 14, density: "comfortable" },
  visuals: { mode: "balanced", robot: "bot", conn: "curve", anim: "normal", labels: true, desc: true, progress: true, tech: true },
  dashboard: { modules: DEFAULT_MODULES.map(([id, , on]) => ({ id, on })), layout: 3 },
  workspace: { view: "live" },
};

const PREFS = { data: structuredClone(DEFAULT_PREFS), timer: null };

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }

function mergePrefs(base, extra) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && !Array.isArray(out[k]) ? { ...out[k], ...v } : v;
  }
  // Módulos nuevos que el usuario aún no tenía: se añaden al final.
  const ids = new Set((out.dashboard.modules || []).map((m) => m.id));
  for (const [id, , on] of DEFAULT_MODULES) if (!ids.has(id)) out.dashboard.modules.push({ id, on });
  out.dashboard.modules = out.dashboard.modules.filter((m) => DEFAULT_MODULES.some(([id]) => id === m.id));
  return out;
}

/** Valores efectivos del tema (preset + personalizaciones). */
function themeValues() {
  const t = PREFS.data.theme;
  return { ...(THEMES[t.preset] || THEMES.cyber), ...(t.preset === "custom" ? THEMES.cyber : {}), ...(t.custom || {}) };
}

/** true si el fondo es claro (el tema White o un Custom con fondo claro). */
function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150;
}

function applyPrefs() {
  const root = document.documentElement;
  const v = themeValues();
  for (const [key] of THEME_TOKENS) if (v[key]) root.style.setProperty(`--th-${key}`, v[key]);
  const t = PREFS.data.theme, vis = PREFS.data.visuals;
  root.dataset.tone = isLight(v.bg) ? "light" : "dark";
  root.style.setProperty("--th-glow", String(t.glow ?? 0.6));
  root.style.setProperty("--th-radius", `${t.radius ?? 14}px`);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  root.dataset.density = t.density || "comfortable";
  root.dataset.anim = reduce ? "off" : vis.anim || "normal";
  root.dataset.agentMode = vis.mode || "balanced";
  root.dataset.robot = vis.robot || "bot";
  root.dataset.conn = vis.conn || "curve";
  root.classList.toggle("hide-labels", !vis.labels);
  root.classList.toggle("hide-desc", !vis.desc);
  root.classList.toggle("hide-progress", !vis.progress);
  root.classList.toggle("hide-tech", !vis.tech);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", v.bg);
  lsSet("cia-prefs", JSON.stringify(PREFS.data));
}

/** Cambia preferencias, las aplica al instante y las guarda en el servidor (con retardo). */
function setPrefs(patch) {
  PREFS.data = mergePrefs(PREFS.data, patch);
  applyPrefs();
  clearTimeout(PREFS.timer);
  PREFS.timer = setTimeout(() => api("PUT", "/api/workspace/prefs", PREFS.data).catch(() => {}), 600);
}

async function loadPrefs() {
  try { PREFS.data = mergePrefs(DEFAULT_PREFS, await api("GET", "/api/workspace/prefs")); }
  catch { /* se queda con la copia local */ }
  applyPrefs();
}

// Primer pintado con la última copia local (evita un destello del tema por defecto).
(() => {
  try { PREFS.data = mergePrefs(DEFAULT_PREFS, JSON.parse(lsGet("cia-prefs") || "{}")); } catch { /* por defecto */ }
  applyPrefs();
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", applyPrefs);
})();

/* ============================================================ APARIENCIA */

async function viewAppearance(main) {
  const t = () => PREFS.data.theme, vis = () => PREFS.data.visuals;
  const presetGrid = h("div", { class: "theme-grid", role: "radiogroup", "aria-label": "Tema" });
  const renderPresets = () => presetGrid.replaceChildren(...[...Object.entries(THEMES), ["custom", { ...themeValues(), title: "Custom" }]].map(([id, th]) =>
    h("button", { type: "button", role: "radio", class: "theme-swatch", "aria-checked": t().preset === id ? "true" : "false",
      onclick: () => { setPrefs({ theme: { preset: id, custom: id === "custom" ? { ...themeValues() } : {} } }); renderAll(); } },
      h("span", { class: "sw", style: `background:${th.bg};--a:${th.primary};--b:${th.secondary}` }, h("i"), h("i"), h("i")),
      h("span", {}, th.title))));

  const colors = h("div", { class: "color-grid" });
  const renderColors = () => {
    const v = themeValues();
    colors.replaceChildren(...THEME_TOKENS.map(([key, label]) => {
      const input = h("input", { type: "color", value: v[key], "aria-label": label });
      input.addEventListener("input", () => {
        const custom = { ...(t().preset === "custom" ? t().custom : themeValues()), [key]: input.value };
        setPrefs({ theme: { preset: "custom", custom } });
        renderPresets();
      });
      return h("label", { class: "color-field" }, input, h("span", {}, label));
    }));
  };

  const slider = (label, value, min, max, step, onInput, fmt = (x) => x) => {
    const out = h("span", { class: "small muted" }, fmt(value));
    const input = h("input", { type: "range", min, max, step, value });
    input.addEventListener("input", () => { out.textContent = fmt(Number(input.value)); onInput(Number(input.value)); });
    return h("div", { class: "slider-field" }, h("div", { class: "row spread" }, h("label", { style: "margin:0" }, label), out), input);
  };
  const seg = (label, options, current, onPick) => {
    const box = h("div", { class: "segctl" });
    const render = (cur) => box.replaceChildren(...options.map(([id, l]) => h("button", { type: "button", "aria-selected": cur === id ? "true" : "false", onclick: () => { onPick(id); render(id); } }, l)));
    render(current);
    return h("div", { class: "seg-field" }, h("label", {}, label), box);
  };
  const toggle = (label, value, onChange) => {
    const cb = h("input", { type: "checkbox", checked: value ? true : null });
    cb.addEventListener("change", () => onChange(cb.checked));
    return h("label", { class: "switch" }, cb, label);
  };

  const preview = h("div", { class: "appearance-preview" });
  const renderPreview = () => preview.replaceChildren(agentNetworkPreview());
  const renderAll = () => { renderPresets(); renderColors(); renderPreview(); };

  main.replaceChildren(h("div", { class: "stack" },
    h("div", { class: "page-head" }, h("div", {}, h("div", { class: "eyebrow" }, "Settings · Appearance"), h("h1", {}, "Apariencia y personalización")),
      h("button", { class: "btn ghost", type: "button", onclick: () => { PREFS.data = structuredClone(DEFAULT_PREFS); setPrefs({}); route(); } }, icon("refresh", 15), "Restablecer")),
    h("div", { class: "appearance" },
      h("div", { class: "stack" },
        h("section", { class: "card" }, h("div", { class: "card-h" }, "Tema"), h("div", { class: "card-b stack" }, presetGrid)),
        h("section", { class: "card" }, h("div", { class: "card-h" }, "Colores"), h("div", { class: "card-b stack" },
          h("p", { class: "small muted" }, "Cualquier cambio crea un tema «Custom» y se aplica al instante."), colors)),
        h("section", { class: "card" }, h("div", { class: "card-h" }, "Interfaz"), h("div", { class: "card-b stack" },
          slider("Intensidad del glow", t().glow, 0, 1, 0.05, (x) => setPrefs({ theme: { glow: x } }), (x) => `${Math.round(x * 100)}%`),
          slider("Radio de bordes", t().radius, 4, 22, 1, (x) => setPrefs({ theme: { radius: x } }), (x) => `${x}px`),
          seg("Densidad", [["compact", "Compacta"], ["comfortable", "Cómoda"], ["spacious", "Amplia"]], t().density, (x) => setPrefs({ theme: { density: x } })),
          seg("Animaciones", [["off", "Off"], ["low", "Suaves"], ["normal", "Normales"]], vis().anim, (x) => setPrefs({ visuals: { anim: x } })),
          h("p", { class: "small muted" }, "Si tu sistema tiene «reducir movimiento», las animaciones se desactivan automáticamente."))),
        h("section", { class: "card" }, h("div", { class: "card-h" }, "Agent visuals"), h("div", { class: "card-b stack" },
          seg("Modo", [["minimal", "Minimal"], ["balanced", "Balanced"], ["immersive", "Immersive"]], vis().mode, (x) => { setPrefs({ visuals: { mode: x } }); renderPreview(); }),
          seg("Estilo de robot", [["bot", "Robot"], ["orb", "Orbe"], ["hex", "Hexágono"]], vis().robot, (x) => { setPrefs({ visuals: { robot: x } }); renderPreview(); }),
          seg("Conexiones", [["curve", "Curvas"], ["straight", "Rectas"], ["dashed", "Discontinuas"]], vis().conn, (x) => { setPrefs({ visuals: { conn: x } }); renderPreview(); }),
          h("div", { class: "toggle-grid" },
            toggle("Etiquetas de agentes", vis().labels, (x) => setPrefs({ visuals: { labels: x } })),
            toggle("Descripciones / acción actual", vis().desc, (x) => setPrefs({ visuals: { desc: x } })),
            toggle("Barras de progreso", vis().progress, (x) => setPrefs({ visuals: { progress: x } })),
            toggle("Información técnica (modelo, tiempos)", vis().tech, (x) => setPrefs({ visuals: { tech: x } })))))),
      h("aside", { class: "card sticky-preview" }, h("div", { class: "card-h" }, "Vista previa"), h("div", { class: "card-b" }, preview,
        h("p", { class: "small muted" }, "Ejemplo ilustrativo de los estilos (no es una ejecución real)."))))));
  renderAll();
}

/** Red de ejemplo para la vista previa de Apariencia (etiquetada como ejemplo). */
function agentNetworkPreview() {
  const state = {
    run: { status: "running", id: 0 },
    agents: [
      { step: "s1", agent_id: "research-agent", role: "RESEARCHER", status: "COMPLETED", action: "Completado", progress: 100, depends_on: [] },
      { step: "s2", agent_id: "data-analyst", role: "ANALYST", status: "ANALYZING", action: "Analizando", progress: 60, depends_on: [] },
      { step: "s3", agent_id: "blog-writer", role: "WRITER", status: "QUEUED", action: "Esperando", progress: 0, depends_on: ["s1", "s2"] },
    ],
  };
  const box = h("div", { class: "net-wrap preview" });
  requestAnimationFrame(() => renderNetwork(box, state, { preview: true }));
  return box;
}
