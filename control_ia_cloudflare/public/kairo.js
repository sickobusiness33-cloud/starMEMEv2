/* Kairo — la inteligencia propia de Control IA.
 *
 * - Marca: logotipo (hexágono con un núcleo que reparte trabajo a tres nodos:
 *   el orquestador y sus agentes), avatar animado y estados.
 * - Chat: cada mensaje lo procesa el AI Orchestrator en el servidor; el
 *   Agent Activity Panel se actualiza en tiempo real con Server-Sent Events.
 * - Todo el contenido se inserta como texto (sin innerHTML).
 */
"use strict";

/* ------------------------------------------------------------- iconos */

const ICONS = {
  kairo: null, // se dibuja con kairoLogo()
  agents: "M12 2l3 5h-6l3-5zM5 13a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 13a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 7v5M12 12l-5 3M12 12l5 3",
  studio: "M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5a1.5 1.5 0 1 0 0-.01",
  panel: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  projects: "M3 7l3-3h5l2 2h8v13H3z",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  connectors: "M7 7h4v4H7zM13 13h4v4h-4zM11 9h2a2 2 0 0 1 2 2v2",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  send: "M4 12l16-8-6 16-2-6z",
  clip: "M16 7l-7.5 7.5a2.1 2.1 0 0 0 3 3L19 10a4.2 4.2 0 0 0-6-6l-7.5 7.5a6.4 6.4 0 0 0 9 9L20 15",
  stop: "M7 7h10v10H7z",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  cpu: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  star: "M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z",
  check: "M5 12l5 5 9-10",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4",
  copy: "M8 8h11v11H8zM5 16V5h11",
  play: "M7 5l12 7-12 7z",
  pause: "M8 5v14M16 5v14",
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  brush: "M4 20c2 0 4-1 4-3 0-1.5 1.5-2 3-2l8-9-3-3-9 8c0 1.5-.5 3-2 3-2 0-3 2-3 6z",
  memory: "M6 4h12v16H6zM9 8h6M9 12h6M9 16h4",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  back: "M15 5l-7 7 7 7",
  bolt: "M13 3L5 14h6l-1 7 8-11h-6z",
  network: "M5 5h4v4H5zM15 5h4v4h-4zM10 15h4v4h-4zM9 7h6M7 9l4.5 6M17 9l-4.5 6",
  sidebar: "M4 4h16v16H4zM9 4v16M15 10l-2 2 2 2",
  sidebarOpen: "M4 4h16v16H4zM9 4v16M13 10l2 2-2 2",
};

function icon(name, size = 18, cls = "") {
  if (name === "kairo") return kairoLogo(size);
  return svg("svg", { class: `ico ${cls}`, viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
    svg("path", { d: ICONS[name] || ICONS.spark }));
}

/* ------------------------------------------------------------- marca */

const BRAND_NAME = "Kairo";

/** Logotipo: hexágono + núcleo que reparte a tres nodos (orquestador → agentes). Usa currentColor: vale en claro y oscuro. */
function kairoLogo(size = 28, state = "idle") {
  return svg("svg", { class: `kairo-logo k-${state}`, viewBox: "0 0 32 32", width: size, height: size, role: "img", "aria-label": BRAND_NAME },
    svg("path", { class: "k-hex", d: "M16 2.8 27.4 9.4v13.2L16 29.2 4.6 22.6V9.4Z", fill: "none", stroke: "currentColor", "stroke-width": 2.2, "stroke-linejoin": "round" }),
    svg("path", { class: "k-branch k-b1", d: "M16 16 L22.4 10.6", stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round" }),
    svg("path", { class: "k-branch k-b2", d: "M16 16 L22.4 21.4", stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round" }),
    svg("path", { class: "k-branch k-b3", d: "M16 16 L9 16", stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round" }),
    svg("circle", { class: "k-node k-n1", cx: 22.4, cy: 10.6, r: 1.9, fill: "currentColor" }),
    svg("circle", { class: "k-node k-n2", cx: 22.4, cy: 21.4, r: 1.9, fill: "currentColor" }),
    svg("circle", { class: "k-node k-n3", cx: 9, cy: 16, r: 1.9, fill: "currentColor" }),
    svg("circle", { class: "k-core", cx: 16, cy: 16, r: 3.4, fill: "var(--k-accent, #3d7cff)" }));
}

/** Avatar de Kairo con estado: idle | thinking | orchestrating | composing | done | error */
function kairoAvatar(state = "idle", size = 40) {
  return h("span", { class: `k-avatar k-${state}`, style: `--s:${size}px`, "aria-hidden": "true" }, kairoLogo(Math.round(size * 0.62), state));
}

const KAIRO_STATE_LABEL = {
  idle: "Listo", queued: "En cola", planning: "Analizando tu petición", running: "Coordinando agentes",
  aggregating: "Componiendo la respuesta", validating: "Revisando el resultado", completed: "Hecho", failed: "Error", cancelled: "Cancelado",
};
const KAIRO_AVATAR_STATE = { queued: "thinking", planning: "thinking", running: "orchestrating", aggregating: "composing", validating: "composing", completed: "done", failed: "error", cancelled: "idle" };

/* ------------------------------------------------------------- estados de agentes */

const AGENT_STATE = {
  IDLE: ["idle", "Disponible"], QUEUED: ["queued", "En cola"], ANALYZING: ["busy", "Analizando"], THINKING: ["busy", "Pensando"],
  SEARCHING: ["busy", "Buscando"], PROCESSING: ["busy", "Procesando"], GENERATING: ["busy", "Generando"], EXECUTING: ["busy", "Ejecutando"],
  COMPLETED: ["done", "Completado"], ERROR: ["error", "Error"],
};

const CAT_ICON = {
  research: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4", trading: "M4 18l5-6 4 3 7-9", coding: "M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12",
  web: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18", marketing: "M4 10v4h3l6 4V6l-6 4zM17 9a4 4 0 0 1 0 6",
  social: "M7 10h10M7 14h6M4 5h16v11H9l-5 4z", data: "M5 19V11M10 19V5M15 19v-7M20 19V8", finance: "M12 3v18M16 7H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H8",
  productivity: "M5 12l4 4 10-10M5 5h6M5 19h14", automation: "M13 3L5 14h6l-1 7 8-11h-6z", writing: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  image: ICONS.image, video: "M4 6h11v12H4zM15 10l5-3v10l-5-3", security: ICONS.shield, business: "M4 8h16v11H4zM9 8V5h6v3",
  general: ICONS.spark, multi: ICONS.agents, browser: "M4 5h16v14H4zM4 9h16M7 7h.01M10 7h.01",
};

function agentGlyph(agent, size = 34) {
  const c = COLOR_HEX[agent.color] || COLOR_HEX.azul;
  return h("span", { class: "a-glyph", style: `--c:${c};--s:${size}px` },
    svg("svg", { viewBox: "0 0 24 24", width: Math.round(size * 0.55), height: Math.round(size * 0.55), fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
      svg("path", { d: CAT_ICON[agent.category] || ICONS.spark })));
}

/* ------------------------------------------------------------- Markdown seguro */

/** Markdown mínimo → nodos DOM (títulos, listas, código, negrita, cursiva, enlaces http). Nunca innerHTML. */
function md(text) {
  const root = h("div", { class: "md" });
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let list = null, listType = null, para = [], code = null;
  const flushPara = () => { if (para.length) { root.append(h("p", {}, inline(para.join(" ")))); para = []; } };
  const flushList = () => { list = null; listType = null; };
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) { root.append(h("pre", { class: "code" }, h("code", {}, code.join("\n")))); code = null; }
      else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
    const hm = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hm) { flushPara(); flushList(); root.append(h(`h${Math.min(4, hm[1].length + 1)}`, {}, inline(hm[2]))); continue; }
    const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const type = li[1] ? "ol" : "ul";
      if (!list || listType !== type) { list = h(type); listType = type; root.append(list); }
      list.append(h("li", {}, inline(li[2])));
      continue;
    }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) { flushPara(); flushList(); root.append(h("hr")); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  if (code) root.append(h("pre", { class: "code" }, h("code", {}, code.join("\n"))));
  flushPara();
  return root;
}

function inline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>)]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(h("strong", {}, t.slice(2, -2)));
    else if (t.startsWith("`")) out.push(h("code", {}, t.slice(1, -1)));
    else if (t.startsWith("[")) { const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(t); out.push(h("a", { href: mm[2], target: "_blank", rel: "noopener noreferrer" }, mm[1])); }
    else if (t.startsWith("http")) out.push(h("a", { href: t, target: "_blank", rel: "noopener noreferrer" }, t));
    else out.push(h("em", {}, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ------------------------------------------------------------- imágenes */

/** Reduce una imagen en el navegador (máx. 1024 px, JPEG) antes de subirla. */
async function shrinkImage(file, max = 1024) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale), hgt = Math.round(img.height * scale);
    const canvas = h("canvas", { width: w, height: hgt });
    canvas.getContext("2d").drawImage(img, 0, 0, w, hgt);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.88), width: w, height: hgt };
  } finally { URL.revokeObjectURL(url); }
}

async function uploadImage(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Solo imágenes PNG, JPEG o WebP.");
  const s = await shrinkImage(file);
  return api("POST", "/api/images/upload", { data_url: s.dataUrl, width: s.width, height: s.height, name: file.name });
}

const imgUrl = (id) => `/api/images/${id}/file`;

/* ================================================================ CHAT KAIRO */

const KX = { panelOpen: false, filter: "" };

async function viewChat(main) {
  const parts = hashParts();
  const threadId = parts[1] ? Number(parts[1]) : null;
  const [threads, reg] = await Promise.all([api("GET", "/api/chat/threads"), api("GET", "/api/chat/agents")]);
  const agentsById = new Map(reg.agents.map((a) => [a.id, a]));

  // --- columna de conversaciones
  const newChat = async () => {
    const t = await api("POST", "/api/chat/threads", {});
    location.hash = `#/chat/${t.id}`;
  };
  const threadList = h("nav", { class: "kx-threads", "aria-label": "Conversaciones" },
    h("button", { class: "btn primary kx-new", type: "button", onclick: newChat }, icon("plus", 16), "Nuevo chat"),
    h("div", { class: "kx-thread-list" }, threads.length ? threads.map((t) =>
      h("a", { class: "kx-thread", href: `#/chat/${t.id}`, "aria-current": t.id === threadId ? "true" : null },
        h("span", { class: "kx-thread-t" }, trunc(t.title, 42)),
        h("span", { class: "kx-thread-m" }, t.mode === "auto" ? (t.auto_mode ? "Auto" : "Manual") : t.mode, " · ", fmtDate(t.updated_at))))
      : h("p", { class: "small muted", style: "padding:8px" }, "Sin conversaciones todavía.")));

  // --- panel de actividad (derecha / hoja inferior en móvil)
  const activity = h("aside", { class: "kx-activity" + (KX.panelOpen ? " open" : ""), "aria-label": "Agent Activity" });
  const sheetToggle = h("button", { class: "kx-sheet-toggle", type: "button", "aria-expanded": KX.panelOpen ? "true" : "false",
    onclick: () => { KX.panelOpen = !KX.panelOpen; activity.classList.toggle("open", KX.panelOpen); sheetToggle.setAttribute("aria-expanded", String(KX.panelOpen)); } },
    h("span", { class: "kx-pulse" }), h("span", { class: "kx-sheet-label" }, `${reg.agents.length} agentes listos`));

  const center = h("section", { class: "kx-main" });
  main.replaceChildren(h("div", { class: "kx" }, threadList, center, activity), sheetToggle);

  const renderActivity = (state) => renderActivityPanel(activity, sheetToggle, reg, agentsById, state);
  renderActivity(null);

  if (!threadId) {
    center.replaceChildren(kairoWelcome(reg, async (prompt) => {
      const t = await api("POST", "/api/chat/threads", {});
      sessionStorage.setItem("kx-pending", prompt);
      location.hash = `#/chat/${t.id}`;
    }));
    return;
  }

  let thread;
  try { thread = await api("GET", `/api/chat/threads/${threadId}`); }
  catch (err) { center.replaceChildren(empty("Conversación no encontrada", err.message, h("button", { class: "btn primary", type: "button", onclick: newChat }, "Nuevo chat"))); return; }

  // --- cabecera del chat
  const status = h("span", { class: "kx-status" }, KAIRO_STATE_LABEL.idle);
  const avatarBox = h("span", {}, kairoAvatar("idle", 38));
  const setKairo = (runStatus) => {
    const st = KAIRO_AVATAR_STATE[runStatus] || "idle";
    avatarBox.replaceChildren(kairoAvatar(st, 38));
    status.textContent = KAIRO_STATE_LABEL[runStatus] || KAIRO_STATE_LABEL.idle;
    status.dataset.state = st;
  };
  const autoToggle = h("button", { class: "kx-mode" + (thread.auto_mode ? " on" : ""), type: "button", role: "switch", "aria-checked": thread.auto_mode ? "true" : "false",
    title: "Auto: Kairo elige los agentes. Manual: los eliges tú." },
    h("span", { class: "kx-mode-dot" }), thread.auto_mode ? "Auto" : "Manual");
  autoToggle.addEventListener("click", async () => {
    thread = { ...thread, ...(await api("PATCH", `/api/chat/threads/${thread.id}`, { auto_mode: !thread.auto_mode })) };
    autoToggle.classList.toggle("on", thread.auto_mode);
    autoToggle.setAttribute("aria-checked", String(thread.auto_mode));
    autoToggle.lastChild.textContent = thread.auto_mode ? "Auto" : "Manual";
    manualBtn.hidden = thread.auto_mode;
    if (!thread.auto_mode) openManual();
  });
  const openManual = () => manualDialog(thread, reg, async (manual) => {
    thread = { ...thread, ...(await api("PATCH", `/api/chat/threads/${thread.id}`, { manual })) };
    toast("Configuración manual guardada");
  });
  const manualBtn = h("button", { class: "btn small ghost", type: "button", hidden: thread.auto_mode ? true : null, onclick: openManual }, icon("sliders", 15), "Configurar");

  const header = h("header", { class: "kx-head" },
    avatarBox,
    h("div", { class: "grow" }, h("div", { class: "kx-title" }, trunc(thread.title, 70)), status),
    autoToggle, manualBtn,
    h("button", { class: "btn small ghost icon-only", type: "button", title: "Borrar conversación", "aria-label": "Borrar conversación", onclick: async () => {
      if (!(await confirmDialog({ title: "Borrar conversación", body: "Se borrará con todos sus mensajes.", confirmLabel: "Borrar", danger: true }))) return;
      await api("DELETE", `/api/chat/threads/${thread.id}`); location.hash = "#/chat";
    } }, icon("trash", 16)));

  // --- mensajes
  const msgs = h("div", { class: "kx-msgs", "aria-live": "polite" });
  const scroll = () => { msgs.scrollTop = msgs.scrollHeight; };
  const msgNode = (m) => kairoMessage(m, agentsById);
  msgs.replaceChildren(...(thread.messages.length ? thread.messages.map(msgNode) : [kairoEmptyThread(reg)]));

  // --- compositor
  const b = await billing(true);
  const lim = b.plans[b.subscription.plan].limits;
  const input = h("textarea", { rows: 1, maxlength: lim.maxInputChars, placeholder: `Escribe a ${BRAND_NAME}…`, "aria-label": "Mensaje" });
  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(220, input.scrollHeight) + "px"; };
  input.addEventListener("input", autosize);
  const chips = h("div", { class: "att-chips" });
  let attached = [];
  const renderChips = () => chips.replaceChildren(...attached.map((a, i) => h("span", { class: "att-chip" + (a.state ? " " + a.state : "") },
    a.id ? h("img", { class: "att-thumb", src: imgUrl(a.id), alt: "" }) : h("span", { class: "att-ico" }, "…"),
    h("span", { class: "att-name" }, trunc(a.name, 22)),
    h("button", { class: "att-x", type: "button", "aria-label": `Quitar ${a.name}`, onclick: () => { attached.splice(i, 1); renderChips(); } }, "×"))));
  const picker = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true, hidden: true, id: "kx-picker" });
  picker.addEventListener("change", async () => {
    for (const f of [...picker.files].slice(0, 4 - attached.length)) {
      const item = { name: f.name, state: "subiendo" }; attached.push(item); renderChips();
      try { const up = await uploadImage(f); item.id = up.id; item.state = ""; }
      catch (err) { item.state = "error"; toast(err.message, true); attached = attached.filter((x) => x !== item); }
      renderChips();
    }
    picker.value = "";
  });
  const sendBtn = h("button", { class: "kx-send", type: "submit", "aria-label": "Enviar" }, icon("send", 18));
  const stopBtn = h("button", { class: "kx-send stop", type: "button", "aria-label": "Detener", hidden: true }, icon("stop", 16));
  const form = h("form", { class: "kx-composer" }, chips,
    h("div", { class: "kx-compose-row" },
      h("button", { class: "kx-attach", type: "button", "aria-label": "Adjuntar imagen", title: "Adjuntar imagen", onclick: () => picker.click() }, icon("clip", 18)),
      input, sendBtn, stopBtn),
    picker,
    h("div", { class: "kx-hint" }, thread.auto_mode ? `${BRAND_NAME} elige automáticamente entre ${reg.agents.length} agentes` : "Modo manual: se usan los agentes que has elegido",
      " · ", `${b.usage_today.chat}/${lim.chatMessagesPerDay} mensajes hoy`));

  center.replaceChildren(header, msgs, form);
  scroll();

  // --- ejecución en curso (SSE)
  let es = null;
  const closeStream = () => { if (es) { es.close(); es = null; } };
  S.cleanups.push(closeStream);
  let liveNode = null;
  const follow = (runId) => {
    closeStream();
    stopBtn.hidden = false; sendBtn.hidden = true;
    stopBtn.onclick = async () => { await api("POST", `/api/chat/runs/${runId}/cancel`).catch((e) => toast(e.message, true)); };
    const onState = (state) => {
      setKairo(state.run.status);
      renderActivity(state);
      if (!liveNode) { liveNode = kairoWorking(); msgs.append(liveNode); scroll(); }
      updateWorking(liveNode, state, agentsById);
      if (!["queued", "planning", "running", "aggregating", "validating"].includes(state.run.status)) finish(state);
    };
    const finish = (state) => {
      closeStream();
      stopBtn.hidden = true; sendBtn.hidden = false;
      if (liveNode) {
        const node = state.message ? msgNode(state.message)
          : h("div", { class: "kx-msg assistant error" }, h("div", { class: "kx-bubble" }, state.run.status === "cancelled" ? "Petición cancelada." : state.run.error || "No se pudo completar la petición."));
        liveNode.replaceWith(node); liveNode = null;
        if (state.message) thread.messages.push(state.message);
        scroll();
      }
      input.focus();
    };
    // Tiempo real con Server-Sent Events; si el navegador no los soporta, consulta cada 2 s.
    if (window.EventSource) {
      es = new EventSource(`/api/chat/runs/${runId}/stream`);
      es.addEventListener("state", (ev) => onState(JSON.parse(ev.data)));
      es.addEventListener("done", () => closeStream());
      es.onerror = () => {
        // Reconexión: EventSource reintenta solo; si la ejecución ya terminó, se pide el estado final.
        api("GET", `/api/chat/runs/${runId}`).then((st) => { if (!["queued", "planning", "running", "aggregating", "validating"].includes(st.run.status)) onState(st); }).catch(() => {});
      };
    } else {
      const tid = every(2000, async () => { const st = await api("GET", `/api/chat/runs/${runId}`); onState(st); if (!["queued", "planning", "running", "aggregating", "validating"].includes(st.run.status)) clearInterval(tid); });
    }
  };

  const send = async (text) => {
    const content = (text ?? input.value).trim();
    if (!content || !stopBtn.hidden) return; // una petición a la vez
    const empty0 = msgs.querySelector(".kx-empty");
    if (empty0) empty0.remove();
    const userMsg = { role: "user", content, images: attached.filter((a) => a.id).map((a) => a.id) };
    msgs.append(msgNode(userMsg)); scroll();
    input.value = ""; autosize();
    const ids = userMsg.images; attached = []; renderChips();
    sendBtn.disabled = true;
    try {
      const res = await api("POST", `/api/chat/threads/${thread.id}/messages`, { content, image_ids: ids });
      if (res.run) follow(res.run.id);
      else if (res.message) { msgs.append(msgNode(res.message)); scroll(); }
    } catch (err) {
      msgs.append(h("div", { class: "kx-msg assistant error" }, h("div", { class: "kx-bubble" }, err.message,
        err.status === 402 || err.status === 429 ? h("span", {}, " ", h("a", { href: "#/upgrade" }, "Ver Pro")) : null)));
      input.value = content; scroll();
    } finally { sendBtn.disabled = false; }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  msgs.addEventListener("click", (e) => { const s = e.target.closest("[data-suggest]"); if (s) send(s.dataset.suggest); });

  if (thread.active_run_id) follow(thread.active_run_id);
  else if (thread.last_run_id) api("GET", `/api/chat/runs/${thread.last_run_id}`).then((st) => { renderActivity(st); setKairo("idle"); }).catch(() => {});
  const pending = sessionStorage.getItem("kx-pending");
  if (pending) { sessionStorage.removeItem("kx-pending"); send(pending); }
  input.focus();
}

const SUGGESTIONS = [
  "Investiga la historia de la energía solar y resúmela en 5 puntos",
  "Crea un post para Instagram sobre mi cafetería con imagen",
  "Escribe una función en JavaScript que valide un IBAN",
  "Hazme un plan de estudio de 4 semanas para aprender SQL",
];

function kairoWelcome(reg, start) {
  const input = h("textarea", { rows: 2, placeholder: `Pide lo que quieras a ${BRAND_NAME}…`, "aria-label": "Tu primera petición" });
  const go = (text) => { const t = (text ?? input.value).trim(); if (t) start(t); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); } });
  const cats = [...new Set(reg.agents.map((a) => a.category_label))];
  return h("div", { class: "kx-welcome" },
    h("div", { class: "kx-hero-logo" }, kairoLogo(84, "orchestrating")),
    h("h1", { class: "kx-hero-title" }, BRAND_NAME),
    h("p", { class: "kx-hero-sub" }, "La inteligencia que coordina a tus agentes. Escribe lo que necesitas: Kairo decide qué agentes trabajan, los ejecuta en paralelo y te da una sola respuesta."),
    h("form", { class: "kx-hero-form", onsubmit: (e) => { e.preventDefault(); go(); } }, input, h("button", { class: "kx-send", type: "submit", "aria-label": "Empezar" }, icon("send", 18))),
    h("div", { class: "kx-suggest" }, SUGGESTIONS.map((s) => h("button", { type: "button", class: "kx-sug", onclick: () => go(s) }, s))),
    h("div", { class: "kx-hero-stats" },
      h("span", {}, h("b", {}, reg.agents.length), " agentes disponibles"),
      h("span", {}, h("b", {}, cats.length), " especialidades"),
      h("span", {}, h("b", {}, reg.models.length), " modelos de texto")));
}

function kairoEmptyThread(reg) {
  return h("div", { class: "kx-empty" }, kairoAvatar("idle", 56),
    h("p", {}, `Todos los agentes (${reg.agents.length}) están disponibles en este chat. Escribe y ${BRAND_NAME} elegirá los necesarios.`),
    h("div", { class: "kx-suggest" }, SUGGESTIONS.slice(0, 3).map((s) => h("button", { type: "button", class: "kx-sug", "data-suggest": s }, s))));
}

function kairoMessage(m, agentsById) {
  if (m.role === "user") {
    return h("div", { class: "kx-msg user" }, h("div", { class: "kx-bubble" },
      (m.images || []).length ? h("div", { class: "kx-imgs" }, m.images.map((id) => h("img", { src: imgUrl(typeof id === "object" ? id.id : id), alt: "Imagen adjunta", loading: "lazy" }))) : null,
      h("div", { class: "pre" }, m.content)));
  }
  const imgs = (m.images || []).map((x) => (typeof x === "object" ? x : { id: x }));
  return h("div", { class: "kx-msg assistant" },
    h("div", { class: "kx-msg-av" }, kairoAvatar("done", 30)),
    h("div", { class: "kx-bubble" },
      h("div", { class: "kx-meta" }, h("b", {}, m.agent_id ? (agentsById.get(m.agent_id)?.name || m.agent_id) : BRAND_NAME),
        m.provider ? providerBadge(m.provider, m.model, m.fallback) : null, m.created_at ? h("span", { class: "muted" }, hhmm(m.created_at)) : null),
      m.notice ? h("div", { class: "kx-notice" }, m.notice) : null,
      md(m.content),
      imgs.length ? h("div", { class: "kx-imgs out" }, imgs.map((x) => h("figure", {},
        h("a", { href: imgUrl(x.id), target: "_blank", rel: "noopener" }, h("img", { src: imgUrl(x.id), alt: "Imagen generada", loading: "lazy" })),
        x.agent ? h("figcaption", {}, agentsById.get(x.agent)?.name || x.agent) : null))) : null,
      h("div", { class: "kx-actions" },
        h("button", { class: "kx-act", type: "button", title: "Copiar", "aria-label": "Copiar respuesta", onclick: () => copyText(m.content) }, icon("copy", 15)))));
}

function kairoWorking() {
  return h("div", { class: "kx-msg assistant working" },
    h("div", { class: "kx-msg-av" }, kairoAvatar("thinking", 30)),
    h("div", { class: "kx-bubble" }, h("div", { class: "kx-working-line" }), h("div", { class: "kx-working-agents" })));
}

function updateWorking(node, state, agentsById) {
  const st = KAIRO_AVATAR_STATE[state.run.status] || "thinking";
  node.querySelector(".kx-msg-av").replaceChildren(kairoAvatar(st, 30));
  const done = state.agents.filter((a) => a.status === "COMPLETED").length;
  const line = state.run.status === "planning" || state.run.status === "queued" ? `${BRAND_NAME} está analizando tu petición…`
    : state.run.status === "aggregating" ? (state.agents.length ? `Combinando los resultados de ${done} agente${done === 1 ? "" : "s"}…` : "Escribiendo la respuesta…")
    : `Coordinando ${state.agents.length} agente${state.agents.length === 1 ? "" : "s"} · ${done} completado${done === 1 ? "" : "s"}`;
  node.querySelector(".kx-working-line").replaceChildren(h("span", { class: "kx-shimmer" }, line));
  node.querySelector(".kx-working-agents").replaceChildren(...state.agents.map((a) => {
    const info = agentsById.get(a.agent_id) || (a.agent_id === "kairo-reviewer" ? { id: a.agent_id, name: "Kairo Critic", color: "turquesa", category: "security" } : { id: a.agent_id, name: a.agent_id, color: "azul", category: "general" });
    return h("span", { class: `kx-chip s-${(AGENT_STATE[a.status] || ["idle"])[0]}` }, agentGlyph(info, 18), info.name);
  }));
}

/* ------------------------------------------------------------- Activity Panel */

function fmtMs(ms) { return ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`; }

function renderActivityPanel(root, toggle, reg, agentsById, state) {
  const active = state ? state.agents : [];
  const running = state && ["queued", "planning", "running", "aggregating", "validating"].includes(state.run.status);
  const busy = active.filter((a) => (AGENT_STATE[a.status] || [])[0] === "busy").length;
  toggle.classList.toggle("live", Boolean(running));
  toggle.querySelector(".kx-sheet-label").textContent = running ? `${busy || active.length} agente${(busy || active.length) === 1 ? "" : "s"} trabajando` : `${reg.agents.length} agentes listos`;

  const head = h("div", { class: "kx-act-head" },
    h("div", {}, h("div", { class: "kx-act-title" }, "Agent Activity"),
      h("div", { class: "kx-act-sub" }, running ? h("span", { class: "kx-live" }, "LIVE") : null,
        state ? `${KAIRO_STATE_LABEL[state.run.status] || state.run.status}${state.run.planner ? ` · plan: ${state.run.planner === "llm" ? "IA" : state.run.planner === "rules" ? "reglas" : "manual"}` : ""}` : "Esperando tu petición")),
    h("button", { class: "kx-act-close", type: "button", "aria-label": "Cerrar panel", onclick: () => toggle.click() }, icon("close", 16)));

  const flow = h("div", { class: "kx-flow" + (running ? " running" : "") });
  // Nodo del orquestador
  flow.append(h("div", { class: "kx-node orchestrator" + (running ? " busy" : "") },
    h("span", { class: "kx-node-ico" }, kairoLogo(20, running ? "orchestrating" : "idle")),
    h("div", { class: "grow" }, h("div", { class: "kx-node-name" }, `${BRAND_NAME} Orchestrator`),
      h("div", { class: "kx-node-act" }, state ? (state.run.reason || KAIRO_STATE_LABEL[state.run.status]) : "Todos los agentes registrados en este chat"))));
  if (state && state.run.direct) {
    flow.append(h("div", { class: "kx-note" }, "Respuesta directa: ningún agente especializado era necesario."));
  }
  for (const a of active) {
    const info = agentsById.get(a.agent_id) || (a.agent_id === "kairo-reviewer" ? { id: a.agent_id, name: "Kairo Critic", color: "turquesa", category: "security" } : { id: a.agent_id, name: a.agent_id, color: "azul", category: "general" });
    const [cls, label] = AGENT_STATE[a.status] || ["idle", a.status];
    const deps = (a.depends_on || []).map((d) => active.find((x) => x.step === d)).filter(Boolean).map((x) => (agentsById.get(x.agent_id) || { name: x.agent_id }).name);
    flow.append(h("div", { class: `kx-node agent s-${cls}`, style: `--c:${COLOR_HEX[info.color] || COLOR_HEX.azul}` },
      h("span", { class: "kx-node-ico" }, agentGlyph(info, 30)),
      h("div", { class: "grow" },
        h("div", { class: "kx-node-top" }, h("span", { class: "kx-node-name" }, info.name), h("span", { class: `kx-state s-${cls}` }, a.status)),
        h("div", { class: "kx-node-act" }, a.action || label),
        cls === "busy" || cls === "done" ? h("div", { class: "kx-progress" }, h("i", { style: `width:${Math.max(4, a.progress || 0)}%` })) : null,
        h("div", { class: "kx-node-meta" },
          a.model ? h("span", {}, a.model.replace(/^@cf\//, "")) : null,
          a.fallback ? h("span", { class: "warn" }, "fallback") : null,
          a.execution_ms != null ? h("span", {}, fmtMs(a.execution_ms)) : null,
          a.confidence != null ? h("span", { title: "Confianza heurística: baja si hubo respaldo o faltaron datos" }, `conf. ${Math.round(a.confidence * 100)}%`) : null,
          deps.length ? h("span", {}, `← ${deps.join(", ")}`) : null))));
  }
  if (state && state.run.notices && state.run.notices.length) flow.append(...state.run.notices.map((n) => h("div", { class: "kx-note warn" }, n)));

  // Registro: todos los agentes disponibles en el chat
  const q = h("input", { type: "search", placeholder: "Buscar agente", value: KX.filter, "aria-label": "Buscar agente" });
  const listBox = h("div", { class: "kx-registry" });
  const renderList = () => {
    const term = KX.filter.toLowerCase();
    const usedIds = new Set(active.map((a) => a.agent_id));
    listBox.replaceChildren(...reg.agents.filter((a) => !term || `${a.name} ${a.category_label} ${a.description}`.toLowerCase().includes(term)).map((a) =>
      h("div", { class: "kx-reg" + (a.locked ? " locked" : "") + (usedIds.has(a.id) ? " used" : ""), title: a.description },
        agentGlyph(a, 24), h("span", { class: "grow" }, a.name), h("span", { class: "kx-reg-st" }, a.locked ? "PRO" : usedIds.has(a.id) ? "EN USO" : "IDLE"))));
  };
  q.addEventListener("input", () => { KX.filter = q.value; renderList(); });
  renderList();
  root.replaceChildren(head, flow,
    h("details", { class: "kx-reg-box", open: !state || !active.length ? true : null },
      h("summary", {}, `Agentes disponibles · ${reg.agents.length}`), q, listBox));
}

/* ------------------------------------------------------------- modo manual */

function manualDialog(thread, reg, onSave) {
  const sel = new Set(thread.manual?.agents || []);
  const off = new Set(thread.manual?.tools_off || []);
  const model = h("select", { id: "mx-model" }, h("option", { value: "" }, "Automático (Model Router)"),
    reg.models.map((m) => h("option", { value: m.id }, `${m.label}${m.source === "platform" ? " · Pro" : m.source === "user" ? " · tu API" : ""}`)));
  model.value = thread.manual?.model || "";
  const count = h("span", { class: "small muted" });
  const upd = () => { count.textContent = `${sel.size}/${reg.max_agents_per_message} agentes`; };
  const q = h("input", { type: "search", placeholder: "Buscar agente" });
  const list = h("div", { class: "mx-list" });
  const renderList = () => list.replaceChildren(...reg.agents.filter((a) => !q.value || `${a.name} ${a.category_label}`.toLowerCase().includes(q.value.toLowerCase())).map((a) => {
    const cb = h("input", { type: "checkbox", checked: sel.has(a.id) ? true : null, disabled: a.locked ? true : null });
    cb.addEventListener("change", () => {
      if (cb.checked && sel.size >= reg.max_agents_per_message) { cb.checked = false; toast(`Máximo ${reg.max_agents_per_message} agentes en tu plan.`, true); return; }
      cb.checked ? sel.add(a.id) : sel.delete(a.id); upd();
    });
    return h("label", { class: "mx-item" + (a.locked ? " locked" : "") }, cb, agentGlyph(a, 24), h("span", { class: "grow" }, a.name, h("small", {}, a.category_label)), a.locked ? h("span", { class: "pill tier-pro" }, "PRO") : null);
  }));
  q.addEventListener("input", renderList);
  renderList(); upd();
  const tools = h("div", { class: "row" }, reg.tools.map((t) => {
    const cb = h("input", { type: "checkbox", checked: off.has(t.id) ? null : true });
    cb.addEventListener("change", () => (cb.checked ? off.delete(t.id) : off.add(t.id)));
    return h("label", { class: "switch small" }, cb, t.label);
  }));
  openDialog("Modo manual", [
    h("p", { class: "small muted" }, "Elige qué agentes trabajan en este chat, con qué modelo y qué herramientas pueden usar. Vuelve a Auto cuando quieras que Kairo decida."),
    field("Modelo de texto", model, "Automático usa la prioridad de tus Ajustes (plataforma → tu API → gratis) con respaldo."),
    h("div", { class: "row spread" }, h("label", { style: "margin:0" }, "Agentes"), count), q, list,
    h("label", {}, "Herramientas permitidas"), tools,
  ], [
    h("button", { class: "btn", type: "button", onclick: () => closeDialog(false) }, "Cancelar"),
    h("button", { class: "btn primary", type: "button", onclick: async () => {
      try { await onSave({ agents: [...sel], model: model.value || null, tools_off: [...off] }); closeDialog(true); } catch (err) { toast(err.message, true); }
    } }, "Guardar"),
  ]);
}

/* ------------------------------------------------------------- Ajustes de IA */

async function aiPrefsCard() {
  const [st, models] = await Promise.all([api("GET", "/api/ai/status"), api("GET", "/api/ai/models")]);
  const LABEL = { platform: "Modelos de la plataforma (Claude en Pro)", user_api: "Mi API (mis claves)", free: "Modelos gratuitos (Cloudflare AI)" };
  let priority = [...st.priority];
  const toggle = h("input", { type: "checkbox", checked: st.use_my_api ? true : null });
  const list = h("ol", { class: "prio" });
  const save = async (patch) => { try { const r = await api("PUT", "/api/ai/settings", patch); priority = r.priority; renderPrio(); toast("Preferencias de IA guardadas"); } catch (err) { toast(err.message, true); } };
  const renderPrio = () => list.replaceChildren(...priority.map((p, i) => h("li", {},
    h("span", { class: "grow" }, LABEL[p]),
    h("button", { class: "btn small ghost", type: "button", disabled: i === 0 ? true : null, "aria-label": "Subir", onclick: () => { const n = [...priority]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; save({ priority: n }); } }, "↑"),
    h("button", { class: "btn small ghost", type: "button", disabled: i === priority.length - 1 ? true : null, "aria-label": "Bajar", onclick: () => { const n = [...priority]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; save({ priority: n }); } }, "↓"))));
  renderPrio();
  toggle.addEventListener("change", () => save({ use_my_api: toggle.checked }));
  const byKind = (k) => models.filter((m) => m.kind === k);
  const modelRow = (m) => h("tr", {}, h("td", {}, m.label), h("td", { class: "small muted" }, m.capabilities.join(", ")),
    h("td", { class: "small" }, m.license, m.notes ? h("div", { class: "muted" }, m.notes) : null),
    h("td", {}, h("span", { class: "pill " + (m.status === "ready" ? "st-ok" : "st-warn") }, m.status === "ready" ? (m.source === "user" ? "tu API" : m.source === "platform" ? "Pro" : "listo") : "enfriando")));
  return h("section", { class: "card" }, h("div", { class: "card-h" }, `${BRAND_NAME} · modelos y API propia`),
    h("div", { class: "card-b stack" },
      h("label", { class: "switch" }, toggle, "Usar mi API"),
      h("p", { class: "small muted" }, st.own_keys.length ? `Claves guardadas: ${st.own_keys.join(", ")}. Con «Usar mi API» activado, el chat, los agentes y el estudio de imágenes pueden usarlas; el consumo lo factura tu proveedor.` : "Añade una clave de Anthropic u OpenAI arriba para poder usar tu propia API. Desactivado, se usa la configuración de la plataforma."),
      h("div", {}, h("div", { class: "mono-up" }, "Prioridad de modelos"), list,
        h("p", { class: "small muted" }, "Si una fuente no está disponible o falla, se pasa automáticamente a la siguiente (fallback).")),
      h("details", {}, h("summary", {}, `Catálogo del Model Router · ${models.length} modelos`),
        h("div", { class: "table-wrap" }, h("table", { class: "log" }, h("thead", {}, h("tr", {}, h("th", {}, "Modelo"), h("th", {}, "Capacidades"), h("th", {}, "Licencia"), h("th", {}, "Estado"))),
          h("tbody", {}, h("tr", {}, h("td", { colspan: 4, class: "mono-up" }, "Texto")), byKind("text").map(modelRow), h("tr", {}, h("td", { colspan: 4, class: "mono-up" }, "Imagen")), byKind("image").map(modelRow)))))));
}
