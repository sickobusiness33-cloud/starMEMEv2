/* Control IA — AI Chat, Agent Hub, ejecuciones con robots, Pro y licencias.
 *
 * Usa los helpers globales de app.js (h, api, toast, svg, withBusy…).
 * Todo el contenido se inserta como texto: nunca como HTML.
 * Ninguna cifra es inventada: usos, métricas y límites vienen de la API.
 */
"use strict";

const hashParts = () => location.hash.replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
const COLOR_HEX = { azul: "#5b8cf5", rosa: "#f26b8a", morado: "#a97cf2", verde: "#58cc6c", turquesa: "#22c1ad", naranja: "#f6a33c", amarillo: "#f7c12e" };
const PROVIDER_LABEL = { claude: "Claude", "claude-byok": "Claude · tu clave", "workers-ai": "Cloudflare AI" };
const AGENT_STATUS = {
  pending: ["en cola", "st-idle"], running: ["trabajando", "st-run"], completed: ["completado", "st-ok"],
  failed: ["fallido", "st-err"], cancelled: ["cancelado", "st-idle"],
};
const AGENT_ACTIVE = new Set(["pending", "running"]);

async function billing(force = false) {
  if (!S.billing || force) S.billing = await api("GET", "/api/billing/plans");
  return S.billing;
}

function fmtPrice(p) {
  try { return new Intl.NumberFormat("es-ES", { style: "currency", currency: p.currency, maximumFractionDigits: 2 }).format(p.amount); }
  catch { return `${p.amount} ${p.currency}`; }
}

function tierPill(tier) {
  return tier === "pro" ? h("span", { class: "pill tier-pro" }, "PRO") : h("span", { class: "pill tier-free" }, "FREE");
}

function providerBadge(provider, model, fallback) {
  if (!provider) return null;
  return h("span", { class: "prov-badge prov-" + provider, title: model || "" },
    PROVIDER_LABEL[provider] || provider, model ? h("span", { class: "muted" }, ` · ${model.replace(/^@cf\//, "")}`) : null,
    fallback ? h("span", { class: "pill st-warn", style: "margin-left:6px" }, "fallback") : null);
}

/* ------------------------------------------------------------ robots SVG
 * Representación propia de cada agente (no se usan imágenes de terceros).
 * state: idle | running | completed | failed | pending
 */
function robot(color, state = "idle", size = 64, seed = 0) {
  const c = COLOR_HEX[color] || COLOR_HEX.azul;
  const eyes = state === "failed" ? "#ea3b4b" : state === "completed" ? "#22b161" : "#1fa3ff";
  const variant = seed % 3;
  const head = variant === 0
    ? svg("rect", { x: 14, y: 16, width: 36, height: 26, rx: 7, fill: "#fff", stroke: "#0e0f11", "stroke-width": 2.5 })
    : variant === 1
      ? svg("rect", { x: 12, y: 17, width: 40, height: 24, rx: 12, fill: "#fff", stroke: "#0e0f11", "stroke-width": 2.5 })
      : svg("path", { d: "M16 42 L16 24 Q16 16 24 16 L40 16 Q48 16 48 24 L48 42 Z", fill: "#fff", stroke: "#0e0f11", "stroke-width": 2.5 });
  return svg("svg", { class: `robot r-${state}`, viewBox: "0 0 64 72", width: size, height: size * 72 / 64, role: "img", "aria-label": `robot ${state}` },
    svg("g", { class: "r-body" },
      svg("line", { x1: 32, y1: 5, x2: 32, y2: 16, stroke: "#0e0f11", "stroke-width": 2.5 }),
      svg("circle", { class: "r-antenna", cx: 32, cy: 5, r: 4, fill: c, stroke: "#0e0f11", "stroke-width": 2 }),
      head,
      svg("rect", { x: 20, y: 19, width: 24, height: 4, rx: 2, fill: c, class: "r-visor" }),
      svg("circle", { class: "r-eye", cx: 25, cy: 30, r: 4, fill: eyes }),
      svg("circle", { class: "r-eye", cx: 39, cy: 30, r: 4, fill: eyes }),
      svg("rect", { x: 26, y: 36, width: 12, height: 2.5, rx: 1, fill: "#0e0f11" }),
      svg("rect", { x: 18, y: 45, width: 28, height: 18, rx: 5, fill: c, stroke: "#0e0f11", "stroke-width": 2.5 }),
      svg("rect", { class: "r-core", x: 27, y: 50, width: 10, height: 7, rx: 2, fill: "#0e0f11" }),
      svg("line", { class: "r-arm r-arm-l", x1: 18, y1: 50, x2: 9, y2: 58, stroke: "#0e0f11", "stroke-width": 3, "stroke-linecap": "round" }),
      svg("line", { class: "r-arm r-arm-r", x1: 46, y1: 50, x2: 55, y2: 58, stroke: "#0e0f11", "stroke-width": 3, "stroke-linecap": "round" }),
      svg("line", { x1: 25, y1: 63, x2: 25, y2: 69, stroke: "#0e0f11", "stroke-width": 3, "stroke-linecap": "round" }),
      svg("line", { x1: 39, y1: 63, x2: 39, y2: 69, stroke: "#0e0f11", "stroke-width": 3, "stroke-linecap": "round" })));
}
const seedOf = (id) => [...String(id)].reduce((a, ch) => a + ch.charCodeAt(0), 0);

/* ================================================================ AI CHAT */

async function viewChat(main) {
  const parts = hashParts();
  const threadId = parts[1] ? Number(parts[1]) : null;
  const [threads, status, hub] = await Promise.all([
    api("GET", "/api/chat/threads"), api("GET", "/api/ai/status"), api("GET", "/api/hub/agents?sort=name"),
  ]);
  const list = h("ul", { class: "convs" });
  const renderList = (items) => list.replaceChildren(...items.map((t) => h("li", {},
    h("button", { type: "button", "aria-current": t.id === threadId ? "true" : null, onclick: () => { location.hash = `#/chat/${t.id}`; } },
      h("div", { class: "small", style: "font-weight:700" }, trunc(t.title, 40)),
      h("div", { class: "small muted" }, modeLabel(t.mode, hub.agents))))));
  renderList(threads);
  const newChat = async (mode = "auto") => {
    const t = await api("POST", "/api/chat/threads", { mode });
    location.hash = `#/chat/${t.id}`;
  };

  const claudeLine = status.claude.usable_by_you
    ? h("span", { class: "pill st-ok" }, status.claude.own_key ? "Claude disponible · tu clave" : "Claude disponible")
    : h("span", { class: "pill st-idle", title: status.claude.reason || "" },
      status.plan === "pro" ? "Claude sin créditos ahora · usando modelo gratuito" : "Claude: con Pro o con tu propia clave");
  const b = await billing(true);
  const lim = b.plans[b.subscription.plan].limits;
  const header = h("div", { class: "row spread chat-status" },
    h("div", { class: "row" }, claudeLine, h("span", { class: "pill st-ok" }, "Cloudflare AI gratis activo")),
    h("span", { class: "small muted" }, `Hoy: ${b.usage_today.chat}/${lim.chatMessagesPerDay} mensajes`));

  const side = h("aside", { class: "card" },
    h("div", { class: "card-h" }, "Conversaciones"),
    h("div", { class: "card-b stack" },
      h("button", { class: "btn primary", type: "button", onclick: () => newChat() }, "+ nueva conversación"),
      threads.length ? list : h("p", { class: "small muted" }, "Aún no tienes conversaciones.")));

  const box = h("section", { class: "card chat-main" });
  main.replaceChildren(h("div", { class: "stack" },
    h("div", { class: "row spread" }, h("h1", {}, "AI Chat"), h("a", { class: "btn small", href: "#/hub" }, "⬡ Agent Hub")),
    header,
    h("div", { class: "chat" }, side, box)));

  if (!threadId) {
    box.replaceChildren(h("div", { class: "card-b" }, h("div", { class: "chat-hero" },
      h("div", { class: "robots-row" }, robot("naranja", "running", 58, 0), robot("azul", "idle", 58, 1), robot("verde", "idle", 58, 2)),
      h("h2", {}, "Habla con Claude, con modelos gratuitos o con un agente"),
      h("p", { class: "muted" }, "En modo automático se usa Claude si está disponible y, si no, un modelo gratuito de Cloudflare. Siempre verás qué modelo respondió."),
      h("div", { class: "row", style: "justify-content:center" },
        h("button", { class: "btn primary", type: "button", onclick: () => newChat("auto") }, "empezar (auto)"),
        h("button", { class: "btn", type: "button", onclick: () => newChat("free") }, "solo gratis"),
        h("button", { class: "btn", type: "button", onclick: () => newChat("claude") }, "solo claude")))));
    return;
  }

  let thread;
  try { thread = await api("GET", `/api/chat/threads/${threadId}`); }
  catch (err) { box.replaceChildren(h("div", { class: "card-b" }, empty("Conversación no encontrada", err.message))); return; }

  const modeSel = h("select", { "aria-label": "Modelo o agente" },
    h("optgroup", { label: "Modelos" },
      h("option", { value: "auto" }, "Auto · Claude → gratis"),
      h("option", { value: "claude" }, "Solo Claude"),
      h("option", { value: "free" }, "Solo gratis (Cloudflare AI)")),
    h("optgroup", { label: "Agentes del Hub" }, hub.agents.filter((a) => !a.multi_agent).map((a) =>
      h("option", { value: `agent:${a.id}`, disabled: a.tier === "pro" && hub.plan !== "pro" ? true : null },
        `${a.name}${a.tier === "pro" ? " (PRO)" : ""}`))));
  modeSel.value = thread.mode;
  modeSel.addEventListener("change", async () => {
    await api("PATCH", `/api/chat/threads/${thread.id}`, { mode: modeSel.value }).catch((e) => toast(e.message, true));
  });

  const msgs = h("div", { class: "msgs", "aria-live": "polite" });
  const msgNode = (m) => h("div", { class: "msg " + m.role },
    m.role === "assistant" ? h("div", { class: "meta" },
      providerBadge(m.provider, m.model, m.fallback),
      m.agent_id ? h("span", { class: "pill tag-dark" }, m.agent_id) : null,
      h("span", {}, hhmm(m.created_at))) : null,
    m.notice ? h("div", { class: "note small" }, "⚠ ", m.notice) : null,
    h("div", { class: "pre" }, m.content));
  msgs.replaceChildren(...(thread.messages.length ? thread.messages.map(msgNode)
    : [h("p", { class: "small muted" }, "Escribe tu primer mensaje. Enter envía · Mayús+Enter salto de línea.")]));
  const scroll = () => { msgs.scrollTop = msgs.scrollHeight; };

  const input = h("textarea", { rows: 3, maxlength: lim.maxInputChars, placeholder: "Pregunta lo que quieras…", "aria-label": "Mensaje" });
  const counter = h("span", { class: "small muted" }, `0/${lim.maxInputChars}`);
  input.addEventListener("input", () => { counter.textContent = `${input.value.length}/${lim.maxInputChars}`; });
  const sendBtn = h("button", { class: "btn primary", type: "submit" }, "enviar ↵");
  const form = h("form", { class: "composer" }, h("div", { class: "grow" }, input, counter), sendBtn);
  const send = async () => {
    const content = input.value.trim();
    if (!content) return;
    if (!thread.messages.length) msgs.replaceChildren();
    msgs.append(msgNode({ role: "user", content }));
    const thinking = h("div", { class: "msg assistant thinking" }, h("div", { class: "row" }, robot("azul", "running", 30, 1), h("span", {}, "pensando"), h("span", { class: "dots" }, h("i"), h("i"), h("i"))));
    msgs.append(thinking); scroll();
    input.value = ""; counter.textContent = `0/${lim.maxInputChars}`;
    sendBtn.disabled = true;
    try {
      const res = await api("POST", `/api/chat/threads/${thread.id}/messages`, { content, mode: modeSel.value });
      thread.messages.push({ role: "user", content }, res.message);
      thinking.replaceWith(msgNode(res.message));
      threads.find((t) => t.id === thread.id) || threads.unshift(thread);
    } catch (err) {
      thinking.replaceWith(h("div", { class: "alert small" }, err.message,
        err.status === 402 || err.status === 429 ? h("span", {}, " ", h("a", { href: "#/upgrade" }, "Ver Pro")) : null));
      input.value = content;
    } finally { sendBtn.disabled = false; scroll(); input.focus(); }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

  box.replaceChildren(
    h("div", { class: "card-h spread" }, h("span", { class: "grow" }, trunc(thread.title, 60)),
      h("button", { class: "btn small danger", type: "button", onclick: async () => {
        if (!(await confirmDialog({ title: "Borrar conversación", body: "Se borrará con todos sus mensajes.", confirmLabel: "Borrar", danger: true }))) return;
        await api("DELETE", `/api/chat/threads/${thread.id}`); location.hash = "#/chat";
      } }, "borrar")),
    h("div", { class: "card-b" }, h("div", { class: "row", style: "margin-bottom:10px" }, h("label", { style: "margin:0" }, "Responde:"), h("div", { class: "grow" }, modeSel)), msgs, form));
  scroll();
  input.focus();
}

function modeLabel(mode, agents) {
  if (mode === "auto") return "auto · claude → gratis";
  if (mode === "claude") return "solo claude";
  if (mode === "free") return "solo gratis";
  const a = agents.find((x) => `agent:${x.id}` === mode);
  return a ? `agente · ${a.name}` : mode;
}

/* ============================================================== AGENT HUB */

const HUB = { q: "", category: "", tier: "", compat: "", sort: "popular" };

async function viewHub(main) {
  const parts = hashParts();
  if (parts[1] === "run" && parts[2]) return viewAgentRun(main, Number(parts[2]));
  if (parts[1]) return viewAgentDetail(main, parts[1]);

  const [cats, b] = await Promise.all([api("GET", "/api/hub/categories"), billing(true)]);
  const grid = h("div", { class: "hub-grid", "aria-live": "polite" });
  const count = h("span", { class: "small muted" });
  const search = h("input", { type: "search", placeholder: "Buscar agentes (trading, código, SEO…)", value: HUB.q, "aria-label": "Buscar agentes" });
  const sel = (key, label, options) => {
    const s = h("select", { "aria-label": label }, options.map(([v, t]) => h("option", { value: v }, t)));
    s.value = HUB[key];
    s.addEventListener("change", () => { HUB[key] = s.value; load(); });
    return s;
  };
  const chips = h("div", { class: "cat-chips", role: "toolbar", "aria-label": "Categorías" });
  const renderChips = () => chips.replaceChildren(
    h("button", { type: "button", class: "cat-chip", "aria-pressed": HUB.category === "" ? "true" : "false", onclick: () => { HUB.category = ""; renderChips(); load(); } },
      "Todas", h("b", {}, cats.reduce((a, c) => a + c.count, 0))),
    ...cats.map((c) => h("button", { type: "button", class: "cat-chip", "aria-pressed": HUB.category === c.id ? "true" : "false",
      onclick: () => { HUB.category = HUB.category === c.id ? "" : c.id; renderChips(); load(); } }, c.label, h("b", {}, c.count))));
  renderChips();

  let timer = null;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { HUB.q = search.value.trim(); load(); }, 220); });

  const load = async () => {
    const qs = new URLSearchParams(Object.entries(HUB).filter(([, v]) => v));
    const data = await api("GET", `/api/hub/agents?${qs}`);
    count.textContent = `${data.total} agentes`;
    grid.replaceChildren(...(data.agents.length ? data.agents.map((a, i) => agentCard(a, i, data.plan))
      : [h("div", { class: "card", style: "grid-column:1/-1" }, empty("Ningún agente coincide", "Prueba con otra búsqueda o categoría."))]));
  };

  const isAdmin = S.user.role === "admin";
  main.replaceChildren(h("div", { class: "stack hub" },
    h("div", { class: "hub-hero card" },
      h("div", { class: "hub-hero-b" },
        h("div", { class: "grow" },
          h("div", { class: "mono-up" }, "centro de control de agentes de ia"),
          h("h1", { class: "hub-title" }, "AGENT", h("span", { class: "glow" }, "·"), "HUB"),
          h("p", { class: "muted" }, "Agentes listos para usar. Los gratuitos funcionan con modelos abiertos en Cloudflare; los premium usan Claude cuando hay créditos y, si no, un modelo de respaldo."),
          h("div", { class: "row" },
            h("span", { class: "pill " + (b.subscription.plan === "pro" ? "tier-pro" : "tier-free") }, `Tu plan: ${b.subscription.plan.toUpperCase()}`),
            h("span", { class: "small muted" }, `Hoy: ${b.usage_today.agents}/${b.plans[b.subscription.plan].limits.agentRunsPerDay} ejecuciones`),
            b.subscription.plan !== "pro" ? h("a", { class: "btn small primary", href: "#/upgrade" }, "hazte pro") : null)),
        h("div", { class: "hub-fleet", "aria-hidden": "true" },
          ["naranja", "azul", "rosa", "verde", "morado"].map((c, i) => h("span", { style: `--i:${i}` }, robot(c, i === 1 ? "running" : "idle", 46, i)))))),
    h("div", { class: "hub-tools" }, search,
      sel("tier", "Plan", [["", "Free y premium"], ["free", "Solo gratis"], ["pro", "Solo premium"]]),
      sel("compat", "Modelo", [["", "Cualquier modelo"], ["free-model", "Funciona con modelo gratuito"], ["claude", "Prefiere Claude"]]),
      sel("sort", "Orden", [["popular", "Más usados"], ["recent", "Recientes"], ["name", "Nombre"]])),
    chips,
    h("div", { class: "row spread" }, count,
      h("div", { class: "row" },
        h("a", { class: "btn small", href: "#/hub-runs" }, "mis ejecuciones"),
        h("a", { class: "btn small", href: "#/fuentes" }, "fuentes y licencias"),
        isAdmin ? h("a", { class: "btn small", href: "#/metricas" }, "métricas") : null)),
    grid));
  await load();
}

function agentCard(a, i, plan) {
  const locked = a.tier === "pro" && plan !== "pro";
  return h("a", { class: "card agent-card" + (locked ? " locked" : ""), href: `#/hub/${a.id}`, style: `--k:${Math.min(i, 20)}` },
    h("div", { class: `node-h col-${a.color}` }, h("span", { class: "title" }, a.name)),
    h("div", { class: "agent-card-b" },
      h("div", { class: "agent-avatar" }, robot(a.color, "idle", 52, seedOf(a.id))),
      h("div", { class: "grow" },
        h("div", { class: "row", style: "gap:6px" }, tierPill(a.tier),
          h("span", { class: "pill tag-dark" }, a.category_label),
          a.multi_agent && a.category !== "multi" ? h("span", { class: "pill tag-blue" }, "multi-agent") : null),
        h("p", { class: "small", style: "margin:6px 0 0" }, a.description))),
    h("div", { class: "agent-card-f small muted" },
      h("span", {}, a.model.prefer === "premium" ? "Claude → respaldo gratis" : "Modelo gratuito"),
      h("span", {}, a.uses ? `${a.uses} usos` : "aún sin usos")));
}

async function viewAgentDetail(main, id) {
  let a;
  try { a = await api("GET", `/api/hub/agents/${encodeURIComponent(id)}`); }
  catch (err) { main.replaceChildren(h("div", { class: "card" }, empty("Agente no encontrado", err.message, h("a", { class: "btn", href: "#/hub" }, "volver al hub")))); return; }
  const b = await billing(true);
  const plan = b.subscription.plan;
  const lim = b.plans[plan].limits;
  const locked = (a.tier === "pro" && !lim.premiumAgents) || (a.multi_agent && !lim.multiAgent);
  const maxChars = Math.min(lim.maxInputChars, a.limits?.maxInputChars || Infinity);

  const input = h("textarea", { rows: 5, maxlength: maxChars, placeholder: a.input.placeholder, id: "agent-input", required: true });
  const counter = h("span", { class: "small muted" }, `0/${maxChars}`);
  input.addEventListener("input", () => { counter.textContent = `${input.value.length}/${maxChars}`; });
  const err = h("div", { class: "alert", hidden: true, role: "alert" });
  const runBtn = h("button", { class: "btn primary big", type: "submit", disabled: locked ? true : null }, "▶ USE AGENT");
  const form = h("form", { class: "stack", novalidate: true },
    field(a.input.label, input), counter, err,
    h("div", { class: "row" }, runBtn,
      h("button", { class: "btn", type: "button", disabled: locked || a.multi_agent ? true : null, onclick: async () => {
        const t = await api("POST", "/api/chat/threads", { mode: `agent:${a.id}`, title: a.name });
        location.hash = `#/chat/${t.id}`;
      } }, "chatear con este agente")),
    locked ? h("div", { class: "note small" }, a.multi_agent ? "Los flujos multiagente" : "Este agente premium", " requieren Control IA Pro. ", h("a", { href: "#/upgrade" }, "Ver Pro")) : null);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!input.value.trim()) { err.textContent = "Escribe qué necesitas."; err.hidden = false; return; }
    err.hidden = true;
    await withBusy(runBtn, async () => {
      try {
        const r = await api("POST", `/api/hub/agents/${a.id}/run`, { input: input.value });
        location.hash = `#/hub/run/${r.id}`;
      } catch (e2) { err.textContent = e2.message; err.hidden = false; }
    });
  });

  const src = a.source;
  main.replaceChildren(h("div", { class: "stack" },
    h("a", { class: "small", href: "#/hub" }, "← Agent Hub"),
    h("div", { class: "agent-detail" },
      h("section", { class: "card" },
        h("div", { class: `node-h col-${a.color}` }, h("span", { class: "title" }, `${a.id}.agent`)),
        h("div", { class: "card-b stack" },
          h("div", { class: "row", style: "align-items:flex-start;gap:16px" },
            h("div", { class: "agent-avatar big" }, robot(a.color, "idle", 84, seedOf(a.id))),
            h("div", { class: "grow" },
              h("h1", {}, a.name),
              h("div", { class: "row", style: "gap:6px;margin:6px 0" }, tierPill(a.tier), h("span", { class: "pill tag-dark" }, a.category_label),
                a.multi_agent ? h("span", { class: "pill tag-blue" }, "multi-agent") : null, h("span", { class: "small muted" }, `v${a.version}`)),
              h("p", {}, a.description))),
          a.multi_agent ? h("div", { class: "info" }, h("div", { class: "mono-up" }, "Equipo de robots"),
            h("div", { class: "robots-row left" }, a.sub_agents_info.map((s, i) => h("a", { class: "mini-bot", href: `#/hub/${s.id}` }, robot(s.color, "idle", 40, seedOf(s.id)), h("span", { class: "small" }, s.name))))) : null,
          form)),
      h("aside", { class: "stack" },
        h("section", { class: "card" }, h("div", { class: "card-h" }, "Modelo"),
          h("div", { class: "card-b small" },
            h("div", { class: "kv" }, "preferido", h("b", {}, a.model.prefer === "premium" ? (a.model.advanced ? "Claude (avanzado)" : "Claude") : "Gratuito (Cloudflare)")),
            h("div", { class: "kv" }, "respaldo", h("b", {}, a.model.fallback ? "modelo gratuito" : "no (requiere Claude)")),
            h("div", { class: "kv" }, "compatible con gratis", h("b", {}, a.model.free_model_compatible ? "sí" : "no")),
            h("div", { class: "kv" }, "tu límite de entrada", h("b", {}, `${maxChars.toLocaleString("es-ES")} car.`)),
            h("div", { class: "kv" }, "usos reales", h("b", {}, a.uses)))),
        h("section", { class: "card" }, h("div", { class: "card-h" }, "Herramientas y permisos"),
          h("div", { class: "card-b small" }, a.tools.length ? h("ul", { class: "perm" }, a.tools.map((t) => h("li", {}, h("b", {}, t.label), ": ", t.permission)))
            : h("p", { class: "muted" }, "Sin herramientas externas: solo el modelo de IA."),
            h("p", { class: "muted", style: "margin-top:8px" }, "Sin acceso a tus archivos, secretos, base de datos, cuentas ni wallets. No realiza acciones financieras."))),
        h("section", { class: "card" }, h("div", { class: "card-h" }, "Capacidades y etapas"),
          h("div", { class: "card-b small" }, h("ul", { class: "perm" }, a.capabilities.map((c) => h("li", {}, c))),
            h("div", { class: "stage-mini" }, a.stages.map((s) => h("span", {}, s.label))))),
        h("section", { class: "card" }, h("div", { class: "card-h" }, "Origen y licencia"),
          h("div", { class: "card-b small stack" },
            h("div", { class: "kv" }, "origen", h("b", {}, src.label)),
            h("div", { class: "kv" }, "licencia", h("b", {}, src.license)),
            src.url ? h("div", {}, h("a", { href: src.url, target: "_blank", rel: "noopener noreferrer" }, src.url.replace("https://", ""))) : null,
            src.attribution ? h("p", { class: "muted" }, src.attribution) : null,
            h("details", {}, h("summary", {}, "Ver instrucciones del agente"), h("div", { class: "pre small muted", style: "margin-top:6px" }, a.instructions))))))));
  input.focus();
}

/* ------------------------------------------------------ ejecución + robots */

const CANON = ["planning", "researching", "analyzing", "generating"];

function stageTimeline(run) {
  const steps = [...run.stages.map((s) => ({ label: s.label, status: s.status, provider: s.provider, model: s.model, fallback: s.fallback })),
    { label: "Completed", status: run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : run.status === "cancelled" ? "cancelled" : "pending" }];
  return h("ol", { class: "timeline" }, steps.map((s, i) => h("li", { class: `tl-${s.status}`, style: `--i:${i}` },
    h("span", { class: "tl-dot" }, s.status === "completed" ? "✓" : s.status === "failed" ? "✕" : s.status === "running" ? h("span", { class: "spin" }, "◌") : i + 1),
    h("span", { class: "tl-label" }, s.label.toUpperCase()),
    s.provider ? h("span", { class: "tl-prov small muted" }, PROVIDER_LABEL[s.provider] || s.provider, s.fallback ? " · fallback" : "") : null)));
}

function robotStage(run, agent) {
  const active = run.stages.find((s) => s.status === "running");
  const team = run.stages.find((s) => s.kind === "agents" && s.agents && s.agents.length);
  const masterState = run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : AGENT_ACTIVE.has(run.status) ? "running" : "idle";
  if (!team) {
    return h("div", { class: "bot-stage solo" },
      h("div", { class: "bot-walk " + masterState }, robot(agent.color, masterState, 96, seedOf(agent.id))),
      h("div", { class: "bot-caption" }, active ? `${active.label}…` : AGENT_STATUS[run.status]?.[0] || run.status));
  }
  // Multiagente: maestro → subagentes → resultado final.
  const W = 640, H = 300, n = team.agents.length;
  const xs = team.agents.map((_, i) => (W / (n + 1)) * (i + 1));
  const teamActive = team.status === "running";
  const finalActive = run.stages.at(-1)?.status === "running" && run.stages.at(-1).kind !== "agents";
  const wires = svg("svg", { class: "team-wires", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" },
    ...xs.flatMap((x, i) => {
      const sub = team.agents[i];
      const hotDown = teamActive && sub.status !== "pending";
      const hotUp = sub.status === "completed" && (teamActive || finalActive);
      return [
        svg("path", { d: `M${W / 2} 62 C ${W / 2} 110, ${x} 90, ${x} 128`, class: "wire" + (hotDown ? " hot" : "") }),
        svg("path", { d: `M${x} 200 C ${x} 232, ${W / 2} 214, ${W / 2} 246`, class: "wire" + (hotUp ? " hot" : "") }),
      ];
    }));
  const subState = (s) => (s.status === "completed" ? "completed" : s.status === "failed" ? "failed" : s.status === "running" ? "running" : "idle");
  return h("div", { class: "bot-stage team" }, wires,
    h("div", { class: "team-node master", style: "left:50%;top:0" },
      (() => { const ms = masterState === "running" && (teamActive || finalActive) ? "idle" : masterState;
        return h("div", { class: "bot-walk " + ms }, robot(agent.color, ms, 54, seedOf(agent.id))); })(),
      h("span", { class: "small" }, "master")),
    ...team.agents.map((s, i) => h("div", { class: "team-node", style: `left:${(xs[i] / W) * 100}%;top:36%` },
      h("div", { class: "bot-walk " + subState(s) }, robot(s.color, subState(s), 50, seedOf(s.id))),
      h("span", { class: "small", style: "font-weight:700" }, s.name),
      h("span", { class: "small muted" }, s.status === "running" ? (s.stage || "…") : AGENT_STATUS[s.status]?.[0] || s.status))),
    h("div", { class: "team-node final", style: "left:50%;top:80%" },
      h("div", { class: "bot-walk " + (finalActive ? "running" : run.status === "completed" ? "completed" : "idle") },
        robot("amarillo", finalActive ? "running" : run.status === "completed" ? "completed" : "idle", 48, 5)),
      h("span", { class: "small" }, "resultado final")));
}

async function viewAgentRun(main, id) {
  const wrap = h("div", { class: "stack" });
  main.replaceChildren(wrap);
  let agent = null;
  let lastSig = "";
  const load = async () => {
    const run = await api("GET", `/api/hub/runs/${id}`);
    if (!agent) agent = await api("GET", `/api/hub/agents/${encodeURIComponent(run.agent_id)}`).catch(() => ({ id: run.agent_id, name: run.agent_id, color: "azul" }));
    const sig = JSON.stringify([run.status, run.stages, run.notices, run.output.length]);
    if (sig === lastSig) return run;
    lastSig = sig;
    const st = AGENT_STATUS[run.status] || [run.status, "st-idle"];
    const output = run.status === "completed"
      ? (run.output_kind === "image"
        ? h("figure", { class: "gen-image" }, h("img", { src: `data:image/jpeg;base64,${run.output}`, alt: `Imagen generada por ${agent.name}` }),
          h("figcaption", { class: "small muted" }, "Generada con FLUX.1 [schnell] (Apache-2.0) en Cloudflare Workers AI. ",
            h("a", { href: `data:image/jpeg;base64,${run.output}`, download: `control-ia-${id}.jpg` }, "Descargar")))
        : h("div", { class: "stack" }, h("div", { class: "pre output" }, run.output),
          h("button", { class: "btn small", type: "button", onclick: () => copyText(run.output) }, "copiar resultado")))
      : run.status === "failed" ? h("div", { class: "alert" }, run.error || "La ejecución falló.")
      : run.status === "cancelled" ? h("div", { class: "info small" }, "Ejecución cancelada.")
      : h("p", { class: "small muted" }, "Los robots están trabajando. Esta página se actualiza sola.");
    wrap.replaceChildren(
      h("div", { class: "row spread" },
        h("a", { class: "small", href: `#/hub/${agent.id}` }, `← ${agent.name}`),
        h("div", { class: "row" },
          AGENT_ACTIVE.has(run.status) ? h("button", { class: "btn small danger", type: "button", onclick: async (e) => {
            await withBusy(e.target, async () => { await api("POST", `/api/hub/runs/${id}/cancel`); lastSig = ""; await load(); });
          } }, "cancelar") : h("a", { class: "btn small", href: `#/hub/${agent.id}` }, "usar de nuevo"))),
      h("section", { class: "card run-card" + (AGENT_ACTIVE.has(run.status) ? " live-card" : "") },
        h("div", { class: `node-h col-${agent.color}` }, h("span", { class: "title" }, `${agent.name} · run #${run.id}`),
          h("span", { class: `pill ${st[1]}` }, st[0])),
        h("div", { class: "card-b stack" },
          robotStage(run, agent),
          stageTimeline(run),
          ...run.notices.map((n) => h("div", { class: "note small" }, "⚠ ", n)),
          h("details", {}, h("summary", { class: "small" }, "Tu petición"), h("div", { class: "pre small muted" }, run.input)),
          run.stages.some((s) => s.preview) ? h("details", {}, h("summary", { class: "small" }, "Trabajo intermedio por etapa"),
            ...run.stages.filter((s) => s.preview).map((s) => h("div", { class: "small", style: "margin-top:8px" },
              h("b", {}, s.label), s.model ? h("span", { class: "muted" }, ` · ${s.model}`) : null,
              h("div", { class: "pre muted" }, s.preview)))) : null)),
      h("section", { class: "card" }, h("div", { class: "card-h" }, "Resultado"), h("div", { class: "card-b" }, output)));
    return run;
  };
  const first = await load();
  if (AGENT_ACTIVE.has(first.status)) {
    const tid = every(1500, async () => { const r = await load(); if (!AGENT_ACTIVE.has(r.status)) clearInterval(tid); });
  }
}

async function viewHubRuns(main) {
  const runs = await api("GET", "/api/hub/runs");
  main.replaceChildren(h("div", { class: "stack" },
    h("div", { class: "row spread" }, h("h1", {}, "Mis ejecuciones de agentes"), h("a", { class: "btn small", href: "#/hub" }, "⬡ Agent Hub")),
    h("section", { class: "card" }, h("div", { class: "card-b table-wrap" }, runs.length ? h("table", { class: "log" },
      h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Agente"), h("th", {}, "Petición"), h("th", {}, "Estado"), h("th", {}, "Fecha"), h("th", {}))),
      h("tbody", {}, runs.map((r) => h("tr", {},
        h("td", { class: "num" }, r.id), h("td", {}, r.agent_id), h("td", {}, trunc(r.input, 60)),
        h("td", {}, h("span", { class: `pill ${(AGENT_STATUS[r.status] || [])[1] || "st-idle"}` }, (AGENT_STATUS[r.status] || [r.status])[0]),
          r.notices.length ? h("span", { class: "pill st-warn", style: "margin-left:4px" }, "fallback") : null),
        h("td", { class: "num" }, fmtDate(r.created_at)),
        h("td", {}, h("a", { href: `#/hub/run/${r.id}` }, "ver")))))) : empty("Sin ejecuciones", "Elige un agente en el Hub y pulsa USE AGENT.", h("a", { class: "btn primary", href: "#/hub" }, "ir al hub"))))));
}

/* ================================================================ UPGRADE */

async function viewUpgrade(main) {
  const b = await billing(true);
  const price = fmtPrice(b.price);
  const sub = b.subscription;
  const F = b.plans.free.limits, P = b.plans.pro.limits;
  const params = new URLSearchParams(location.search);
  const estado = params.get("estado");
  const yes = (v) => (v ? "✓" : "—");
  const rows = [
    ["Mensajes de chat al día", F.chatMessagesPerDay, P.chatMessagesPerDay],
    ["Ejecuciones de agentes al día", F.agentRunsPerDay, P.agentRunsPerDay],
    ["Contexto por petición (caracteres)", F.maxInputChars.toLocaleString("es-ES"), P.maxInputChars.toLocaleString("es-ES")],
    ["Respuesta máxima (tokens)", F.maxOutputTokens.toLocaleString("es-ES"), P.maxOutputTokens.toLocaleString("es-ES")],
    ["Agentes gratuitos (Cloudflare AI)", "✓", "✓"],
    ["Agentes premium", yes(F.premiumAgents), yes(P.premiumAgents)],
    ["Flujos multiagente", yes(F.multiAgent), yes(P.multiAgent)],
    ["Claude con créditos de la plataforma", yes(F.claude), yes(P.claude)],
    ["Claude con tu propia clave", "✓", "✓"],
  ];
  const btn = h("button", { class: "btn primary big", type: "button", disabled: sub.plan === "pro" || !b.payments_enabled ? true : null, onclick: async (e) => {
    await withBusy(e.target, async () => {
      try { const r = await api("POST", "/api/billing/checkout"); if (r.url) location.href = r.url; }
      catch (err) { toast(err.message, true); }
    });
  } }, sub.plan === "pro" ? "ya eres pro" : b.payments_enabled ? `suscribirme · ${price}/mes` : "pagos próximamente");

  main.replaceChildren(h("div", { class: "stack upgrade" },
    estado === "ok" ? h("div", { class: "info" }, "✓ Pago recibido por la pasarela. Tu plan se actualizará en cuanto llegue la confirmación.") : null,
    estado === "cancelado" ? h("div", { class: "note" }, "Pago cancelado. No se ha cobrado nada.") : null,
    h("section", { class: "card pro-hero" },
      h("div", { class: "node-h col-naranja" }, h("span", { class: "title" }, "control-ia.pro")),
      h("div", { class: "card-b pro-hero-b" },
        h("div", { class: "grow stack" },
          h("div", { class: "mono-up" }, "suscripción"),
          h("h1", { class: "hub-title" }, "CONTROL IA ", h("span", { class: "glow" }, "PRO")),
          h("div", { class: "price" }, h("b", {}, price), h("span", { class: "muted" }, " / mes")),
          h("p", { class: "muted" }, "Más límites, agentes premium, flujos multiagente y Claude como modelo preferente cuando la plataforma tenga créditos. Si Claude no está disponible, tus agentes siguen funcionando con el modelo gratuito de respaldo."),
          !b.payments_enabled ? h("div", { class: "note small" }, "Los pagos todavía no están activados: no se puede contratar ni se cobra nada por ahora.") : null,
          h("div", { class: "row" }, btn,
            h("span", { class: "small muted" }, `Tu plan: ${sub.plan.toUpperCase()}${sub.renewal_date ? ` · renueva ${fmtDate(sub.renewal_date)}` : ""}`))),
        h("div", { class: "hub-fleet", "aria-hidden": "true" }, ["naranja", "morado", "azul"].map((c, i) => h("span", { style: `--i:${i}` }, robot(c, "running", 54, i)))))),
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Qué incluye Pro"),
      h("div", { class: "card-b" }, h("ul", { class: "features" }, b.plans.pro.features.map((f) => h("li", {},
        h("span", { class: f.status === "available" ? "feat-ok" : "feat-soon" }, f.status === "available" ? "✓" : "◷"), f.label,
        f.status === "coming_soon" ? h("span", { class: "pill st-idle", style: "margin-left:8px" }, "Coming soon") : null))))),
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Free vs Pro"),
      h("div", { class: "card-b table-wrap" }, h("table", { class: "log compare" },
        h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Free"), h("th", {}, `Pro · ${price}/mes`))),
        h("tbody", {}, rows.map(([l, f, p]) => h("tr", {}, h("td", {}, l), h("td", {}, String(f)), h("td", {}, h("b", {}, String(p))))))))),
    h("p", { class: "small muted" }, `Hoy has usado ${b.usage_today.chat} mensajes de chat y ${b.usage_today.agents} ejecuciones de agentes.`)));
}

/* ================================================== FUENTES Y LICENCIAS */

async function viewSources(main) {
  const isAdmin = S.user.role === "admin";
  const state = { q: "", status: "", page: 0 };
  const repoBox = h("div", {});
  const countsBox = h("div", { class: "row" });
  const load = async () => {
    const qs = new URLSearchParams({ q: state.q, status: state.status, page: String(state.page) });
    const d = await api("GET", `/api/hub/sources?${qs}`);
    countsBox.replaceChildren(...["compatible", "restricted", "incompatible", "unverifiable", "pending"].map((s) =>
      h("span", { class: "pill " + ({ compatible: "st-ok", restricted: "st-warn", incompatible: "st-err", unverifiable: "st-idle", pending: "st-idle" }[s]) }, `${s}: ${d.counts[s] || 0}`)));
    repoBox.replaceChildren(h("table", { class: "log" },
      h("thead", {}, h("tr", {}, h("th", {}, "Repositorio"), h("th", {}, "Listado en"), h("th", {}, "Licencia"), h("th", {}, "Estado"), h("th", {}, "Revisado"))),
      h("tbody", {}, d.repos.map((r) => h("tr", {},
        h("td", {}, h("a", { href: `https://github.com/${r.repo}`, target: "_blank", rel: "noopener noreferrer" }, r.repo)),
        h("td", { class: "num" }, r.found_in || "—"),
        h("td", {}, r.license || "—", r.license_flags ? h("div", { class: "small muted" }, r.license_flags) : null),
        h("td", {}, r.license_status),
        h("td", { class: "num" }, fmtDate(r.checked_at)))))),
    h("div", { class: "row", style: "margin-top:8px" },
      h("button", { class: "btn small", type: "button", disabled: state.page === 0 ? true : null, onclick: () => { state.page--; load(); } }, "← anterior"),
      h("span", { class: "small muted" }, `página ${state.page + 1}`),
      h("button", { class: "btn small", type: "button", disabled: d.repos.length < 50 ? true : null, onclick: () => { state.page++; load(); } }, "siguiente →")));
    return d;
  };
  const d = await load();
  const search = h("input", { type: "search", placeholder: "Buscar repositorio", "aria-label": "Buscar repositorio" });
  let t = null;
  search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { state.q = search.value.trim(); state.page = 0; load(); }, 250); });
  const statusSel = h("select", { "aria-label": "Estado de licencia" }, ["", "compatible", "restricted", "incompatible", "unverifiable", "pending"].map((s) => h("option", { value: s }, s || "todos los estados")));
  statusSel.addEventListener("change", () => { state.status = statusSel.value; state.page = 0; load(); });

  const INT = { method: ["metodología", "st-ok"], reference: ["referencia", "st-idle"], excluded: ["excluido", "st-err"] };
  main.replaceChildren(h("div", { class: "stack" },
    h("div", { class: "row spread" }, h("h1", {}, "Fuentes open source y licencias"), h("a", { class: "btn small", href: "#/hub" }, "⬡ Agent Hub")),
    h("div", { class: "info small" }, "Control IA no copia código de otros repositorios. Los agentes son manifiestos propios; algunos siguen metodologías públicas de proyectos con licencia MIT/Apache-2.0/BSD y se citan abajo. ",
      "Los proyectos con licencias no comerciales, con cláusulas adicionales o sin licencia verificable están excluidos. ", `Verificado: ${d.verified_at}.`),
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Modelos"),
      h("div", { class: "card-b table-wrap" }, h("table", { class: "log" },
        h("thead", {}, h("tr", {}, h("th", {}, "Modelo"), h("th", {}, "Licencia"), h("th", {}, "Uso"), h("th", {}, "Atribución"))),
        h("tbody", {}, d.models.map((m) => h("tr", {}, h("td", {}, m.name), h("td", {}, m.license), h("td", {}, m.use), h("td", {}, m.attribution))))))),
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Frameworks y proyectos analizados"),
      h("div", { class: "card-b table-wrap" }, h("table", { class: "log" },
        h("thead", {}, h("tr", {}, h("th", {}, "Proyecto"), h("th", {}, "Licencia"), h("th", {}, "Integración"), h("th", {}, "Lenguaje"), h("th", {}, "Cloudflare"), h("th", {}, "Notas"))),
        h("tbody", {}, d.frameworks.map((f) => h("tr", {},
          h("td", {}, h("a", { href: `https://github.com/${f.repo}`, target: "_blank", rel: "noopener noreferrer" }, f.name)),
          h("td", {}, f.license), h("td", {}, h("span", { class: `pill ${INT[f.integration][1]}` }, INT[f.integration][0])),
          h("td", {}, f.language), h("td", {}, f.cloudflare), h("td", { class: "small muted" }, f.notes))))))),
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Catálogo de repositorios (Update Checker)"),
      h("div", { class: "card-b stack" },
        h("p", { class: "small muted" }, "Repositorios descubiertos en listas públicas (awesome-*). Solo se guarda el nombre y el resultado de revisar su archivo LICENSE; nunca se descarga ni ejecuta su código. Un repositorio compatible no se incorpora automáticamente: debe convertirse en un manifiesto validado."),
        countsBox,
        isAdmin ? h("div", { class: "row" }, h("button", { class: "btn small primary", type: "button", onclick: async (e) => {
          await withBusy(e.target, async () => { const r = await api("POST", "/api/hub/sources/check", { limit: 80 }); toast(`${r.queued} repositorios en cola de verificación`); });
        } }, "verificar 80 licencias pendientes")) : null,
        h("div", { class: "row" }, h("div", { class: "grow" }, search), statusSel),
        h("div", { class: "table-wrap" }, repoBox))),
    isAdmin ? await adminSubmissions() : null));
}

async function adminSubmissions() {
  const list = h("div", { class: "stack" });
  const load = async () => {
    const rows = await api("GET", "/api/hub/submissions");
    list.replaceChildren(...(rows.length ? rows.map((r) => h("div", { class: "info small" },
      h("div", { class: "row spread" }, h("b", {}, r.id), h("span", { class: "pill " + (r.status === "available" ? "st-ok" : r.status === "rejected" ? "st-err" : "st-idle") }, r.status)),
      h("ul", { class: "perm" }, r.validation.map((c) => h("li", {}, c.ok ? "✓ " : "✕ ", h("b", {}, c.step), ": ", c.detail))),
      h("div", { class: "row" },
        ["validated", "disabled"].includes(r.status) ? h("button", { class: "btn small primary", type: "button", onclick: async () => { await api("POST", `/api/hub/submissions/${r.id}/publish`).catch((e) => toast(e.message, true)); load(); } }, "publicar") : null,
        r.status === "available" ? h("button", { class: "btn small danger", type: "button", onclick: async () => { await api("POST", `/api/hub/submissions/${r.id}/disable`); load(); } }, "desactivar") : null)))
      : [h("p", { class: "small muted" }, "Aún no se han añadido agentes como manifiesto.")]));
  };
  await load();
  const ta = h("textarea", { rows: 10, spellcheck: "false", placeholder: '{ "id": "mi-agente", "name": "…", … }', "aria-label": "Manifiesto JSON" });
  const out = h("div", {});
  return h("section", { class: "card" }, h("div", { class: "card-h" }, "Añadir agente (manifiesto) · admin"),
    h("div", { class: "card-b stack" },
      h("p", { class: "small muted" }, "Pipeline: LICENSE CHECK → SECURITY CHECK → DEPENDENCY CHECK → COMPATIBILITY CHECK → REGISTRY (validado) → publicar (disponible). Los manifiestos no pueden contener código, secretos ni instalaciones."),
      ta,
      h("button", { class: "btn primary", type: "button", onclick: async (e) => {
        let manifest;
        try { manifest = JSON.parse(ta.value); } catch { toast("El JSON no es válido.", true); return; }
        await withBusy(e.target, async () => {
          const resp = await api("POST", "/api/hub/submissions", { manifest }, { raw: true });
          const data = await resp.json().catch(() => ({}));
          out.replaceChildren(data.checks ? h("ul", { class: "perm small" }, data.checks.map((c) => h("li", {}, c.ok ? "✓ " : "✕ ", h("b", {}, c.step), ": ", c.detail)))
            : h("div", { class: "alert small" }, data.error || "Error"));
          load();
        });
      } }, "validar manifiesto"),
      out, list));
}

/* ======================================================== MÉTRICAS ADMIN */

async function viewMetrics(main) {
  if (S.user.role !== "admin") { main.replaceChildren(h("div", { class: "alert" }, "Solo para administradores.")); return; }
  const days = Number(new URLSearchParams(location.hash.split("?")[1] || "").get("d") || 7);
  const m = await api("GET", `/api/metrics/admin?days=${days}`);
  const t = m.totals;
  const table = (cols, rows) => rows.length ? h("table", { class: "log" }, h("thead", {}, h("tr", {}, cols.map(([, l]) => h("th", {}, l)))),
    h("tbody", {}, rows.map((r) => h("tr", {}, cols.map(([k]) => h("td", {}, r[k] ?? "—")))))) : h("p", { class: "small muted" }, "Sin datos en este periodo.");
  const email = h("input", { type: "email", required: true, placeholder: "email del usuario" });
  const plan = h("select", {}, h("option", { value: "pro" }, "pro"), h("option", { value: "free" }, "free"));
  const months = h("input", { type: "number", min: 0, max: 36, value: 1 });
  main.replaceChildren(h("div", { class: "stack" },
    h("div", { class: "row spread" }, h("h1", {}, "Métricas"),
      h("div", { class: "row" }, [1, 7, 30].map((d) => h("a", { class: "btn small" + (d === days ? " primary" : ""), href: `#/metricas?d=${d}` }, `${d} d`)))),
    h("div", { class: "info small" }, "Datos reales registrados por el AI Router. El coste es una estimación con precios públicos; los tokens marcados como estimados se calculan por longitud de texto."),
    h("div", { class: "grid" },
      h("section", { class: "card" }, h("div", { class: "card-h" }, "Totales"), h("div", { class: "card-b statlist" },
        h("div", { class: "kv" }, "llamadas a modelos", h("b", {}, t.calls)),
        h("div", { class: "kv" }, "éxito", h("b", {}, t.calls ? `${Math.round((t.ok / t.calls) * 100)}%` : "—")),
        h("div", { class: "kv" }, "fallback", h("b", {}, t.fallbacks)),
        h("div", { class: "kv" }, "latencia media", h("b", {}, `${t.avg_latency_ms} ms`)),
        h("div", { class: "kv" }, "usuarios", h("b", {}, t.users)),
        h("div", { class: "kv blue" }, "coste estimado", h("b", {}, `$${Number(t.cost_usd).toFixed(4)}`)))),
      h("section", { class: "card" }, h("div", { class: "card-h" }, "Claude (plataforma)"), h("div", { class: "card-b statlist" },
        h("div", { class: "kv" }, "configurado", h("b", {}, m.claude.configured ? "sí" : "no")),
        h("div", { class: "kv" }, "disponible", h("b", {}, m.claude.available ? "sí" : "no")),
        m.claude.retry_after ? h("div", { class: "kv" }, "reintenta", h("b", {}, fmtDate(m.claude.retry_after))) : null,
        m.claude.last_error ? h("div", { class: "note small" }, m.claude.last_error) : null,
        h("div", { class: "kv" }, "modelo", h("b", {}, m.claude.model)),
        m.claude.retry_after ? h("button", { class: "btn small", type: "button", onclick: async (e) => {
          await withBusy(e.target, async () => { await api("POST", "/api/metrics/admin/claude/retry"); toast("Claude se volverá a intentar en la próxima petición"); route(); });
        } }, "reintentar claude ya") : null)),
      h("section", { class: "card" }, h("div", { class: "card-h" }, "Asignar plan (manual, sin cobro)"), h("div", { class: "card-b" },
        h("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
          e.preventDefault();
          try { const r = await api("POST", "/api/billing/admin/set-plan", { email: email.value.trim(), plan: plan.value, months: Number(months.value) }); toast(`Plan ${r.plan} asignado`); }
          catch (err) { toast(err.message, true); }
        } }, field("Email", email), field("Plan", plan), field("Meses (0 = sin caducidad)", months), h("button", { class: "btn primary", type: "submit" }, "asignar"))))),
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Por proveedor y modelo"), h("div", { class: "card-b table-wrap" },
      table([["provider", "Proveedor"], ["model", "Modelo"], ["calls", "Llamadas"], ["ok", "OK"], ["fallbacks", "Fallback"], ["avg_latency_ms", "Latencia ms"], ["input_tokens", "Tokens in"], ["output_tokens", "Tokens out"], ["cost_usd", "Coste $"]], m.by_provider))),
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Por agente"), h("div", { class: "card-b table-wrap" },
      table([["agent_id", "Agente"], ["runs", "Ejecuciones"], ["completed", "Completadas"], ["failed", "Fallidas"], ["cancelled", "Canceladas"], ["with_fallback", "Con fallback"], ["avg_duration_ms", "Duración ms"]], m.by_agent))),
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Por plan"), h("div", { class: "card-b table-wrap" },
      table([["plan", "Plan"], ["kind", "Tipo"], ["calls", "Llamadas"], ["cost_usd", "Coste $"]], m.by_plan),
      h("div", { style: "margin-top:10px" }, table([["plan", "Plan"], ["subscription_status", "Estado"], ["users", "Usuarios"]], m.subscriptions)))),
    h("section", { class: "card" }, h("div", { class: "card-h" }, "Errores recientes"), h("div", { class: "card-b table-wrap" },
      table([["created_at", "Fecha"], ["provider", "Proveedor"], ["model", "Modelo"], ["kind", "Tipo"], ["agent_id", "Agente"], ["error", "Error"]], m.recent_errors)))));
}

/* ============================================== flota de robots en el panel */

function agentFleet(runs) {
  if (!runs || !runs.length) {
    return h("section", { class: "card fleet" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, "Agent fleet"), h("a", { class: "btn small", href: "#/hub" }, "abrir hub")),
      h("div", { class: "card-b" }, h("p", { class: "small muted" }, "Todavía no has lanzado agentes. Cada ejecución aparecerá aquí como un robot.")));
  }
  return h("section", { class: "card fleet" }, h("div", { class: "card-h spread" }, h("span", { class: "grow" }, "Agent fleet"),
    runs.some((r) => AGENT_ACTIVE.has(r.status)) ? h("span", { class: "live" }, "LIVE") : null),
    h("div", { class: "card-b fleet-row" }, runs.map((r) => {
      const state = r.status === "completed" ? "completed" : r.status === "failed" ? "failed" : AGENT_ACTIVE.has(r.status) ? "running" : "idle";
      const cur = r.stages.find((s) => s.status === "running");
      return h("a", { class: "fleet-bot", href: `#/hub/run/${r.id}`, title: `${r.agent_id} · ${r.status}` },
        h("div", { class: "bot-walk " + state }, robot(["azul", "rosa", "morado", "verde", "turquesa", "naranja"][seedOf(r.agent_id) % 6], state, 44, seedOf(r.agent_id))),
        h("span", { class: "small", style: "font-weight:700" }, trunc(r.agent_id, 18)),
        h("span", { class: "small muted" }, cur ? cur.label : (AGENT_STATUS[r.status] || [r.status])[0]));
    })));
}
