// Adapter de Cloudflare Workers AI (texto, visión e imagen) a través del binding AI.

import { b64ToBytes } from "../../b64";
import { estimateTokens, stripThinking, textOf, type ImageCall, type ImageOut, type TextCall, type TextOut } from "./types";

// JPEG 1×1 usado solo en AI_MODE=mock (tests locales, sin coste).
export const MOCK_JPEG = b64ToBytes(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
);

function toWorkersMessages(call: TextCall) {
  const vision = call.model.capabilities.includes("vision");
  const msgs: any[] = [{ role: "system", content: call.system }];
  for (const m of call.messages) {
    if (typeof m.content === "string" || !vision) msgs.push({ role: m.role, content: textOf(m.content) });
    else {
      msgs.push({
        role: m.role,
        content: m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.b64}` } })),
      });
    }
  }
  return msgs;
}

function parseText(res: any): string {
  if (typeof res === "string") return res;
  if (typeof res?.response === "string") return res.response;
  if (res?.choices?.[0]?.message?.content) return res.choices[0].message.content;
  if (typeof res?.output_text === "string") return res.output_text;
  // Formato Responses (gpt-oss): output[] con mensajes y bloques output_text.
  if (Array.isArray(res?.output)) {
    return res.output
      .filter((o: any) => o.type === "message")
      .flatMap((o: any) => o.content ?? [])
      .map((c: any) => c.text ?? "")
      .join("");
  }
  return res?.response ? JSON.stringify(res.response) : "";
}

// Ventana de contexto (tokens) de cada modelo de texto. Por defecto, la más pequeña conocida.
const CONTEXT: Record<string, number> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": 24_000,
  "@cf/meta/llama-3.1-8b-instruct-fp8": 32_000,
  "@cf/mistralai/mistral-small-3.1-24b-instruct": 128_000,
  "@cf/qwen/qwen2.5-coder-32b-instruct": 32_000,
  "@cf/qwen/qwq-32b": 24_000,
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": 80_000,
  "@cf/openai/gpt-oss-120b": 128_000,
};
// Estimación prudente (español ≈ 3 caracteres por token) para no pasarse nunca de la ventana.
const tok = (s: string) => Math.ceil(s.length / 3);
const clipText = (s: string, maxTok: number) => (tok(s) <= maxTok ? s : `${s.slice(0, Math.floor(maxTok * 0.35 * 3))}\n\n[… recortado para caber en el modelo …]\n\n${s.slice(-Math.floor(maxTok * 0.6 * 3))}`);
const partsTok = (c: any) => (typeof c === "string" ? tok(c) : c.reduce((n: number, p: any) => n + (p.type === "text" ? tok(p.text) : 1200), 0));

/** Ajusta sistema + historial a la ventana del modelo: quita los mensajes más antiguos y recorta los enormes. */
export function fitContext(msgs: any[], modelId: string, maxTokens: number): { msgs: any[]; maxTokens: number } {
  const window = CONTEXT[modelId] ?? 24_000;
  const out = Math.min(maxTokens, Math.floor(window * 0.25));
  const budget = window - out - 500;
  const total = () => msgs.reduce((n, m) => n + partsTok(m.content) + 8, 0);
  if (total() <= budget) return { msgs, maxTokens: out };
  msgs = msgs.map((m) => ({ ...m }));
  if (typeof msgs[0].content === "string") msgs[0].content = clipText(msgs[0].content, Math.floor(budget * 0.3));
  // Quita historial antiguo (conserva sistema y el último mensaje) mientras no quepa.
  while (msgs.length > 2 && total() > budget) msgs.splice(1, 1);
  // Si aún no cabe, recorta los textos más largos.
  for (const m of [...msgs].sort((a, b) => partsTok(b.content) - partsTok(a.content))) {
    if (total() <= budget) break;
    const rest = total() - partsTok(m.content);
    const room = Math.max(1000, budget - rest);
    if (typeof m.content === "string") m.content = clipText(m.content, room);
    else m.content = m.content.map((p: any) => (p.type === "text" ? { ...p, text: clipText(p.text, room) } : p));
  }
  // Los modelos de chat esperan que tras el sistema venga un mensaje del usuario.
  if (msgs[1]?.role === "assistant") msgs.splice(1, 1);
  return { msgs, maxTokens: out };
}

export async function workersText(call: TextCall): Promise<TextOut> {
  const { env } = call;
  const fitted = fitContext(toWorkersMessages(call), call.modelId, call.maxTokens);
  const messages = fitted.msgs;
  call = { ...call, maxTokens: fitted.maxTokens };
  if (env.AI_MODE === "mock") {
    const last = textOf(call.messages[call.messages.length - 1]?.content ?? "");
    if (last.includes("[forzar-error-gratis]")) throw new Error("Workers AI no disponible (simulado en test)");
    if (last.includes("[forzar-cupo]")) throw new Error("4006: you have used up your daily free allocation of 10,000 neurons (simulado)");
    if (last.includes("[forzar-error-modelo]") && call.modelId === "@cf/meta/llama-3.3-70b-instruct-fp8-fast") throw new Error("modelo caído (simulado)");
    if (last.includes("[lento]")) await new Promise((r) => setTimeout(r, 1500));
    // El planificador del orquestador recibe una respuesta vacía en mock: usa su planificador por reglas.
    if (call.system.startsWith("[planner]")) return { text: "{}", input: 1, output: 1, estimated: true };
    if (call.system.startsWith("[factory:")) {
      const text = factoryMock(call.system, call.messages.map((m) => textOf(m.content)).join("\n"));
      return { text, input: estimateTokens(JSON.stringify(messages)), output: estimateTokens(text), estimated: true };
    }
    if (call.system.startsWith("[autopilot:")) {
      const text = autopilotMock(call.system, call.messages.map((m) => textOf(m.content)).join("\n"));
      return { text, input: estimateTokens(JSON.stringify(messages)), output: estimateTokens(text), estimated: true };
    }
    const text = `[modelo de prueba ${call.modelId}] ${last.slice(0, 400)}`;
    return { text, input: estimateTokens(JSON.stringify(messages)), output: estimateTokens(text), estimated: true };
  }
  if (!env.AI) throw new Error("El binding de Workers AI no está configurado.");
  const input =
    call.model.format === "responses"
      ? { instructions: messages[0].content, input: messages.slice(1).map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : textOf(m.content) })), max_output_tokens: Math.max(call.maxTokens, 2048), reasoning: { effort: "low" } }
      : { messages, max_tokens: call.maxTokens };
  const res: any = await env.AI.run(call.modelId as any, input as any);
  const text = stripThinking(parseText(res));
  if (!text) throw new Error(`${call.model.label} devolvió una respuesta vacía.`);
  const u = res?.usage ?? {};
  const inTok = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const outTok = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  return inTok || outTok
    ? { text, input: inTok, output: outTok, estimated: false }
    : { text, input: estimateTokens(JSON.stringify(messages)), output: estimateTokens(text), estimated: true };
}

async function toBytes(res: any): Promise<Uint8Array> {
  if (res instanceof Uint8Array) return res;
  if (res instanceof ArrayBuffer) return new Uint8Array(res);
  if (res && typeof res.getReader === "function") return new Uint8Array(await new Response(res).arrayBuffer());
  if (typeof res?.image === "string") return b64ToBytes(res.image);
  throw new Error("El modelo de imagen no devolvió ninguna imagen.");
}

const round64 = (n: number) => Math.max(256, Math.round(n / 64) * 64);

export async function workersImage(call: ImageCall): Promise<ImageOut> {
  const { env, model } = call;
  if (env.AI_MODE === "mock") {
    if (call.prompt.includes("[forzar-error-imagen]") && model.id === "@cf/black-forest-labs/flux-1-schnell") throw new Error("modelo de imagen caído (simulado)");
    return { bytes: MOCK_JPEG, mime: "image/jpeg" };
  }
  if (!env.AI) throw new Error("El binding de Workers AI no está configurado.");
  const max = model.maxSize ?? 1024;
  const width = Math.min(round64(call.width), max);
  const height = Math.min(round64(call.height), max);
  let input: Record<string, unknown>;
  if (model.format === "flux") {
    // FLUX.1 schnell solo acepta prompt y steps (≤ 8); no admite semilla.
    input = { prompt: call.prompt.slice(0, 2048), steps: 6 };
  } else {
    input = {
      prompt: call.prompt.slice(0, 2048),
      negative_prompt: (call.negative || "blurry, low quality, watermark, text artifacts").slice(0, 1000),
      width,
      height,
      num_steps: model.id.includes("lightning") || model.id.includes("lcm") ? 8 : 20,
      guidance: model.id.includes("lcm") ? 1.5 : 7.5,
      ...(call.seed !== undefined ? { seed: call.seed } : {}),
    };
  }
  const res: any = await env.AI.run(model.id as any, input as any);
  const bytes = await toBytes(res);
  if (bytes.length < 100) throw new Error("El modelo devolvió una imagen vacía.");
  const mime = bytes[0] === 0x89 ? "image/png" : "image/jpeg";
  return { bytes, mime };
}

/** Respuestas deterministas del Autopilot en AI_MODE=mock (tests). Marcadores en el título. */
function autopilotMock(system: string, all: string): string {
  const role = system.slice(11, system.indexOf("]"));
  if (role === "planner") {
    const tasks = all.includes("[mock-riesgo]")
      ? [
          { title: "La api key del proyecto: muestra su valor en el log", detail: "test", role: "security" },
          { title: "Arreglar el formulario [forzar-pr]", detail: "test", role: "coding" },
          { title: "Tarea imposible [forzar-fallo]", detail: "test", role: "docs" },
        ]
      : [
          { title: "Investigar el estado actual del objetivo", detail: "Resume qué hay que hacer.", role: "research" },
          { title: "Documentar el plan de trabajo", detail: "Escribe el plan.", role: "docs", depends_on: [0] },
        ];
    return JSON.stringify({ analysis: "Plan de prueba", tasks });
  }
  if (role === "reviewer") return JSON.stringify({ ok: true, issues: [], summary: "Correcto (mock)" });
  if (all.includes("[forzar-fallo]")) return "esto no es JSON";
  if (all.includes("[forzar-pr]")) return JSON.stringify({ thought: "Cambio pequeño", tool: "repo.propose_pr", args: { title: "Arreglo del formulario", description: "Cambio mínimo de prueba.", files: [{ path: "src/form.js", content: "export const ok = true;\n" }] } });
  if (all.includes("RESULTADO DE memory.write")) return JSON.stringify({ thought: "listo", final: "Hecho: guardé el hallazgo en memoria (mock)." });
  return JSON.stringify({ thought: "Guardo lo aprendido", tool: "memory.write", args: { kind: "knowledge", content: "Hallazgo de prueba del agente " + role } });
}

/** Respuestas deterministas de la fábrica en AI_MODE=mock (tests). */
function factoryMock(system: string, all: string): string {
  const role = system.slice(9, system.indexOf("]"));
  const crypto = /Nicho: crypto|crypto-trending/.test(all);
  if (role === "research") {
    const tag = (all.match(/Indicación del dueño: ([^.]*)/)?.[1] ?? "").slice(0, 20);
    return JSON.stringify({ ideas: [
      { name: crypto ? `Radar Meme ${tag}`.trim() : `Asistente IA ${tag}`.trim(), idea: crypto ? "Detecta meme coins con liquidez real y alerta de riesgos para traders minoristas." : "Genera textos de producto para tiendas online en segundos.", widgets: crypto ? ["crypto-trending", "crypto-lookup"] : ["ai-tool"] },
      { name: crypto ? `Pulso Solana ${tag}`.trim() : `Prompt Lab ${tag}`.trim(), idea: crypto ? "Panel de tokens nuevos en Solana con volumen y compras/ventas en vivo." : "Mejora prompts para modelos de IA con ejemplos y explicación." },
    ] });
  }
  if (role === "coins") {
    const n = Number(all.match(/Propón (\d+) meme coins/)?.[1] ?? 2);
    const seed = Date.now().toString(36).slice(-4).toUpperCase();
    return JSON.stringify({ coins: Array.from({ length: n }, (_, i) => ({ name: `Gato Lunar ${seed}${i}`, ticker: `GL${seed}${i}`.slice(0, 8), idea: "Un gato astronauta que siempre llega tarde a la luna; la comunidad hace memes de sus excusas." })) });
  }
  if (role === "editor") {
    const m = all.match(/BORRADOR:\n(\{[\s\S]*\})\n\nDevuelve/);
    try { return JSON.stringify({ ...JSON.parse(m?.[1] ?? "{}"), quality: 9, review: "Nombre más corto y eslóganes con más gancho." }); } catch { return "{}"; }
  }
  if (role === "coin") {
    const out = JSON.stringify({
    theme: "gatos astronautas", mascot: "Lunar", style: "sticker", chain: "Solana", taxes: "0% / 0%", slogans: ["Llegamos tarde, pero llegamos", "Excusa del día", "Miau a la luna"],
    art_prompt: "cat astronaut floating near the moon", meme_prompt: "cat astronaut oversleeping in a rocket",
    name: all.match(/Concepto: ([^($]+)/)?.[1]?.trim() || "Gato Lunar", tagline: "El gato que llega tarde a la luna", description: "Una meme coin conceptual sobre un gato astronauta impuntual.",
    lore: "Todo empezó cuando un gato llamado Lunar se coló en un cohete de juguete. Desde entonces promete llegar a la luna cada lunes, pero siempre encuentra una excusa nueva: una siesta, una caja vacía o un rayo de sol perfecto. La comunidad colecciona sus excusas.",
    traits: ["Impuntual", "Casco de pecera", "Optimista"], tokenomics: { supply: "1.000.000.000", distribution: [{ label: "Liquidez", pct: 80 }, { label: "Comunidad", pct: 15 }, { label: "Marketing", pct: 5 }] },
    roadmap: [{ phase: "Fase 1", text: "Nace el meme y la comunidad." }, { phase: "Fase 2", text: "Concurso de excusas." }, { phase: "Fase 3", text: "Cómic colaborativo." }],
    community: ["Excusa del día", "Stickers del casco"], logo_prompt: "cute orange cat astronaut with fishbowl helmet",
    ai: { label: "Habla con Lunar", placeholder: "Pregúntale por qué llega tarde…", examples: ["¿Cuándo llegas a la luna?"], system: "Eres Lunar, un gato astronauta simpático que siempre tiene una excusa graciosa." },
    brand: { bg: "#0b0a12", surface: "#15131f", text: "#f6f4ff", muted: "#a59fbf", accent: "#ffb020", accent2: "#7c5cff", fonts: "unbounded", radius: 18, mode: "dark" },
    hero: { eyebrow: "MEME COIN", title: "El gato que siempre llega tarde a la luna", subtitle: "Un meme, una mascota y una comunidad.", cta: "Conoce a Lunar" },
    faq: [{ q: "¿Se puede comprar?", a: "No: es un concepto." }, { q: "¿Quién lo creó?", a: "Kairo Factory." }, { q: "¿Tiene precio?", a: "No." }],
    seo: { title: "Gato Lunar · meme coin conceptual", description: "Conoce a Lunar, el gato astronauta que siempre llega tarde a la luna: lore, tokenomics y comunidad.", keywords: ["meme coin"] },
  });
    // [mock-cortado] simula una respuesta truncada por el límite de tokens (fallo real de producción).
    return all.includes("[mock-cortado]") ? out.slice(0, Math.floor(out.length * 0.72)) : out;
  }

  if (role === "product") return JSON.stringify({ go: !all.includes("[mock-rechazo]"), score: all.includes("[mock-rechazo]") ? 3 : 8, audience: "Traders y curiosos", value: "Datos reales sin ruido", risks: ["volatilidad"], monetization: ["afiliación", "plan pro"], why: "Hay demanda y datos públicos fiables." });
  if (role === "architect") return JSON.stringify({
    name: crypto ? "Radar Meme" : "Asistente IA", tagline: "Datos reales, decisiones más claras", archetype: crypto ? "terminal" : "spotlight",
    widgets: crypto ? [{ type: "crypto-trending", title: "Tokens en tendencia" }, { type: "crypto-lookup", title: "Analiza un token" }, { type: "ai-tool", title: "Explícamelo" }] : [{ type: "ai-tool", title: "Pruébalo" }],
    ai: { label: "Generar", placeholder: "Escribe tu producto…", examples: ["Zapatillas de running ligeras"], system: "Eres un redactor experto en fichas de producto claras, honestas y persuasivas para ecommerce en español." },
    features: [{ title: "En vivo", text: "Datos de APIs públicas actualizados cada minuto." }, { title: "Claro", text: "Métricas clave sin ruido." }, { title: "Alertas", text: "Heurísticas de riesgo transparentes." }, { title: "Gratis", text: "Sin registro." }],
    steps: [{ title: "Busca", text: "Escribe un token." }, { title: "Analiza", text: "Revisa liquidez y volumen." }, { title: "Decide", text: "Con información, no con hype." }],
    faq: [{ q: "¿De dónde salen los datos?", a: "De DexScreener y CoinGecko." }, { q: "¿Es consejo financiero?", a: "No." }, { q: "¿Cada cuánto se actualiza?", a: "Cada minuto." }],
    seo: { title: crypto ? "Radar Meme · tokens en vivo" : "Asistente IA para productos", description: "Herramienta gratuita con datos reales en vivo y análisis claro para tomar mejores decisiones cada día.", keywords: ["meme coins", "dexscreener"] },
    disclaimer: "",
  });
  if (role === "uiux") return JSON.stringify({ brand: { bg: "#08080b", surface: "#121218", text: "#f4f4f6", muted: "#9a9aab", accent: "#c6ff3d", accent2: "#7c5cff", fonts: "unbounded", radius: 14, mode: "dark" }, hero: { eyebrow: "EN VIVO", title: "Encuentra señal entre el ruido", subtitle: "Liquidez, volumen y riesgo de cada token, en tiempo real.", cta: "Ver tokens" } });
  return "{}";
}
