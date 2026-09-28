/* Estudio de imágenes: texto→imagen, imagen→imagen, inpainting, variaciones y
 * upscaling a través del Model Router (con AUTO y respaldo entre modelos). */
"use strict";

const STUDIO = { mode: "t2i", style: "none", size: "1024x1024", model: "auto", source: null, strength: 0.6, prompt: "", negative: "" };

const MODES = [
  ["t2i", "Texto → imagen"], ["i2i", "Imagen → imagen"], ["inpaint", "Inpainting"], ["variation", "Variaciones"], ["upscale", "Upscale 2×"],
];
const MODE_CAP = { t2i: "t2i", i2i: "i2i", variation: "i2i", inpaint: "inpaint", upscale: "upscale" };

async function viewStudio(main) {
  const meta = await api("GET", "/api/images/models");
  const out = h("div", { class: "st-stage" });
  const gallery = h("div", { class: "st-gallery" });
  const usage = h("span", { class: "small muted" });
  const setUsage = (used) => { usage.textContent = `${used}/${meta.limits.per_day} imágenes hoy`; };
  setUsage(meta.limits.used_today);

  // --- controles
  const prompt = h("textarea", { rows: 4, maxlength: 2000, placeholder: "Describe la imagen: sujeto, estilo, luz, composición…", id: "st-prompt" });
  prompt.value = STUDIO.prompt;
  prompt.addEventListener("input", () => { STUDIO.prompt = prompt.value; });
  const negative = h("input", { type: "text", maxlength: 1000, placeholder: "Qué evitar (opcional)", id: "st-neg" });
  negative.value = STUDIO.negative;
  negative.addEventListener("input", () => { STUDIO.negative = negative.value; });

  const modeTabs = h("div", { class: "segctl", role: "tablist", "aria-label": "Modo" });
  const renderModes = () => modeTabs.replaceChildren(...MODES.map(([id, label]) => h("button", { type: "button", role: "tab", "aria-selected": STUDIO.mode === id ? "true" : "false",
    onclick: () => { STUDIO.mode = id; renderModes(); renderModels(); renderSource(); } }, label)));

  const styles = h("div", { class: "chips" });
  const renderStyles = () => styles.replaceChildren(...meta.styles.map((s) => h("button", { type: "button", class: "chip-btn", "aria-pressed": STUDIO.style === s.id ? "true" : "false",
    onclick: () => { STUDIO.style = s.id; renderStyles(); } }, s.label)));

  const size = h("select", { id: "st-size" }, meta.sizes.map((s) => h("option", { value: `${s.width}x${s.height}` }, `${s.width} × ${s.height}`)));
  size.value = STUDIO.size;
  size.addEventListener("change", () => { STUDIO.size = size.value; });

  const model = h("select", { id: "st-model" });
  const renderModels = () => {
    const cap = MODE_CAP[STUDIO.mode];
    const ok = meta.models.filter((m) => m.capabilities.includes(cap));
    model.replaceChildren(h("option", { value: "auto" }, "AUTO · el mejor disponible"), ...ok.map((m) => h("option", { value: m.id }, `${m.label}${m.source === "user" ? " · tu API" : ""}`)));
    if (![...model.options].some((o) => o.value === STUDIO.model)) STUDIO.model = "auto";
    model.value = STUDIO.model;
  };
  model.addEventListener("change", () => { STUDIO.model = model.value; });

  const strength = h("input", { type: "range", min: 0.1, max: 0.95, step: 0.05, value: STUDIO.strength, id: "st-strength" });
  const strengthVal = h("span", { class: "small muted" }, `${Math.round(STUDIO.strength * 100)}%`);
  strength.addEventListener("input", () => { STUDIO.strength = Number(strength.value); strengthVal.textContent = `${Math.round(STUDIO.strength * 100)}%`; });
  const seed = h("input", { type: "number", min: 0, max: 2147483646, placeholder: "aleatoria", id: "st-seed" });

  // --- imagen de partida (+ máscara para inpainting)
  const sourceBox = h("div", { class: "st-source" });
  let maskCanvas = null;
  const picker = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
  picker.addEventListener("change", async () => {
    const f = picker.files[0]; picker.value = "";
    if (!f) return;
    try { const up = await uploadImage(f); STUDIO.source = up.id; renderSource(); } catch (err) { toast(err.message, true); }
  });
  const renderSource = () => {
    const needs = STUDIO.mode !== "t2i";
    sourceBox.hidden = !needs;
    maskCanvas = null;
    if (!needs) return;
    if (!STUDIO.source) {
      sourceBox.replaceChildren(h("button", { class: "st-drop", type: "button", onclick: () => picker.click() }, icon("image", 22), h("span", {}, "Sube una imagen de partida"), h("small", {}, "o usa una de tu galería con «Usar como base»")), picker);
      return;
    }
    const img = h("img", { src: imgUrl(STUDIO.source), alt: "Imagen de partida" });
    const wrap = h("div", { class: "st-src-img" }, img);
    const tools = [];
    if (STUDIO.mode === "inpaint") {
      maskCanvas = h("canvas", { class: "st-mask", "aria-label": "Pinta la zona a cambiar" });
      wrap.append(maskCanvas);
      img.addEventListener("load", () => setupMask(maskCanvas, img));
      tools.push(h("button", { class: "btn small ghost", type: "button", onclick: () => setupMask(maskCanvas, img) }, "Borrar máscara"));
    }
    sourceBox.replaceChildren(wrap, h("div", { class: "row" },
      STUDIO.mode === "inpaint" ? h("span", { class: "small muted" }, "Pinta en blanco la zona a regenerar.") : null,
      ...tools, h("button", { class: "btn small ghost", type: "button", onclick: () => picker.click() }, "Cambiar"), h("button", { class: "btn small ghost", type: "button", onclick: () => { STUDIO.source = null; renderSource(); } }, "Quitar")), picker);
  };

  const genBtn = h("button", { class: "btn primary big st-gen", type: "submit" }, icon("spark", 17), "Generar");
  const form = h("form", { class: "st-controls card", novalidate: true },
    h("div", { class: "card-b stack" },
      modeTabs, sourceBox,
      field(STUDIO.mode === "upscale" ? "Notas (opcional)" : "Prompt", prompt),
      h("div", {}, h("label", {}, "Estilo"), styles),
      h("div", { class: "st-grid2" }, field("Resolución", size), field("Modelo", model)),
      h("details", {}, h("summary", { class: "small" }, "Avanzado"),
        h("div", { class: "stack", style: "margin-top:10px" }, field("Prompt negativo", negative),
          h("div", {}, h("label", { for: "st-strength" }, "Intensidad (imagen→imagen) ", strengthVal), strength), field("Semilla", seed))),
      h("div", { class: "row spread" }, usage, genBtn)));

  const show = (res) => {
    const im = res.image;
    STUDIO.last = im;
    out.replaceChildren(h("figure", { class: "st-result" },
      h("img", { src: imgUrl(im.id), alt: im.prompt || "Imagen generada" }),
      h("figcaption", {},
        h("div", { class: "small" }, h("b", {}, im.model?.replace(/^@cf\//, "") || ""), ` · ${im.width}×${im.height} · ${fmtMs(im.latency_ms)} · semilla ${im.seed ?? "—"}`),
        ...(res.notices || []).map((n) => h("div", { class: "kx-notice" }, n)),
        h("div", { class: "row" },
          h("button", { class: "btn small", type: "button", onclick: () => run({}) }, icon("refresh", 15), "Regenerar"),
          h("button", { class: "btn small", type: "button", onclick: () => { STUDIO.source = im.id; run({ mode: "variation" }); } }, "Variación"),
          h("button", { class: "btn small", type: "button", onclick: () => { STUDIO.source = im.id; run({ mode: "upscale" }); } }, "Upscale 2×"),
          h("button", { class: "btn small", type: "button", onclick: () => { STUDIO.source = im.id; STUDIO.mode = "i2i"; renderModes(); renderModels(); renderSource(); window.scrollTo({ top: 0, behavior: "smooth" }); } }, "Usar como base"),
          saveBtn(im),
          h("a", { class: "btn small ghost", href: imgUrl(im.id), download: `kairo-${im.id}` }, icon("download", 15), "Descargar")))));
  };

  const run = async (override) => {
    const mode = override.mode || STUDIO.mode;
    if (mode === "t2i" && prompt.value.trim().length < 3) { toast("Describe la imagen que quieres.", true); prompt.focus(); return; }
    if (mode !== "t2i" && !STUDIO.source) { toast("Elige una imagen de partida.", true); return; }
    const [w, hh] = STUDIO.size.split("x").map(Number);
    const body = { mode, prompt: prompt.value.trim(), negative: negative.value.trim() || undefined, style: STUDIO.style, width: w, height: hh, model: STUDIO.model,
      source_id: mode === "t2i" ? undefined : STUDIO.source, strength: mode === "i2i" || mode === "inpaint" ? STUDIO.strength : undefined,
      seed: seed.value ? Number(seed.value) : undefined };
    if (mode === "inpaint") {
      if (!maskCanvas) { toast("Pinta la zona a regenerar.", true); return; }
      body.mask_data_url = maskCanvas.toDataURL("image/png");
    }
    out.replaceChildren(h("div", { class: "st-loading" }, kairoLogo(56, "orchestrating"), h("span", { class: "kx-shimmer" }, "Generando con el Model Router…")));
    genBtn.disabled = true;
    try {
      const res = await api("POST", "/api/images/generate", body);
      show(res);
      loadGallery();
      setUsage((await api("GET", "/api/images/models")).limits.used_today);
    } catch (err) {
      out.replaceChildren(h("div", { class: "alert" }, err.message));
    } finally { genBtn.disabled = false; }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); run({}); });

  const saveBtn = (im) => {
    const b = h("button", { class: "btn small" + (im.saved ? " primary" : ""), type: "button" }, icon("star", 15), im.saved ? "Guardada" : "Guardar");
    b.addEventListener("click", async () => {
      const r = await api("PATCH", `/api/images/${im.id}`, { saved: !im.saved }); im.saved = r.saved;
      b.className = "btn small" + (im.saved ? " primary" : ""); b.lastChild.textContent = im.saved ? "Guardada" : "Guardar";
      loadGallery();
    });
    return b;
  };

  let onlySaved = false;
  const galleryHead = h("div", { class: "row spread" }, h("h2", {}, "Galería"),
    h("div", { class: "segctl small" },
      h("button", { type: "button", "aria-selected": "true", onclick: (e) => { onlySaved = false; e.target.parentElement.children[1].setAttribute("aria-selected", "false"); e.target.setAttribute("aria-selected", "true"); loadGallery(); } }, "Recientes"),
      h("button", { type: "button", "aria-selected": "false", onclick: (e) => { onlySaved = true; e.target.parentElement.children[0].setAttribute("aria-selected", "false"); e.target.setAttribute("aria-selected", "true"); loadGallery(); } }, "Guardadas")));
  const loadGallery = async () => {
    const rows = await api("GET", `/api/images${onlySaved ? "?saved=1" : ""}`);
    gallery.replaceChildren(...(rows.length ? rows.map((im) => h("button", { class: "st-thumb", type: "button", title: im.prompt, onclick: () => show({ image: im }) },
      h("img", { src: imgUrl(im.id), alt: im.prompt || "", loading: "lazy" }), im.saved ? h("span", { class: "st-star" }, "★") : null))
      : [h("p", { class: "small muted" }, onlySaved ? "Aún no has guardado imágenes." : "Tus imágenes aparecerán aquí. Las no guardadas se conservan las 40 más recientes.")]));
  };

  renderModes(); renderStyles(); renderModels(); renderSource();
  out.replaceChildren(h("div", { class: "st-empty" }, kairoLogo(64, "idle"), h("p", {}, "Tu imagen aparecerá aquí."),
    h("p", { class: "small muted" }, `AUTO elige el mejor modelo disponible (${meta.models.filter((m) => m.source === "free").map((m) => m.label).join(", ")}) y, si uno falla, prueba el siguiente.`)));
  main.replaceChildren(h("div", { class: "stack studio" },
    h("div", { class: "page-head" }, h("div", {}, h("div", { class: "mono-up" }, "Kairo Studio"), h("h1", {}, "Estudio de imágenes")),
      h("a", { class: "btn small ghost", href: "#/fuentes" }, "Modelos y licencias")),
    h("div", { class: "st-layout" }, form, h("section", { class: "card st-out" }, h("div", { class: "card-b" }, out))),
    galleryHead, gallery));
  await loadGallery();
}

/** Lienzo de máscara: se pinta en blanco la zona a regenerar (negro = conservar). */
function setupMask(canvas, img) {
  const w = img.naturalWidth || 512, hh = img.naturalHeight || 512;
  canvas.width = w; canvas.height = hh;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, hh);
  let drawing = false;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * hh]; };
  const paint = (e) => { if (!drawing) return; const [x, y] = pos(e); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(x, y, Math.max(12, w / 22), 0, Math.PI * 2); ctx.fill(); };
  canvas.onpointerdown = (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); paint(e); };
  canvas.onpointermove = paint;
  canvas.onpointerup = () => { drawing = false; };
}
