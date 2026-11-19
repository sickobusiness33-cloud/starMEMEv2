// Catálogo de modelos del MODEL ROUTER.
//
// Cada modelo declara su proveedor (adapter), capacidades, licencia y
// atribución. Añadir un modelo = añadir una entrada aquí (y, si es de un
// proveedor nuevo, un adapter en ./adapters). Solo se incluyen modelos con
// licencia que permite uso comercial; los que añaden restricciones de uso
// (OpenRAIL) se muestran con su aviso.

export type Capability =
  | "chat" | "code" | "reasoning" | "vision" // texto
  | "t2i" | "i2i" | "inpaint"; // imagen

export type AdapterId = "workers-ai" | "anthropic" | "openai";

export interface ModelInfo {
  id: string;
  label: string;
  adapter: AdapterId;
  kind: "text" | "image";
  capabilities: Capability[];
  license: string;
  attribution?: string;
  /** platform = créditos de la plataforma (Claude) · free = Workers AI · user = solo con la API del usuario */
  source: "free" | "platform" | "user";
  notes?: string;
  /** Formato de llamada en Workers AI. */
  format?: "chat" | "responses" | "flux" | "sd";
  maxSize?: number; // lado máximo (imagen)
}

export const MODELS: ModelInfo[] = [
  // --- Texto · Cloudflare Workers AI (gratuitos dentro de la cuota diaria) ---
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B", adapter: "workers-ai", kind: "text", capabilities: ["chat", "code"], license: "Llama 3.3 Community License", attribution: "Built with Llama", source: "free", format: "chat" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fp8", label: "Llama 3.1 8B", adapter: "workers-ai", kind: "text", capabilities: ["chat"], license: "Llama 3.1 Community License", attribution: "Built with Llama", source: "free", format: "chat" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B", adapter: "workers-ai", kind: "text", capabilities: ["chat", "vision"], license: "Apache-2.0", attribution: "Mistral AI", source: "free", format: "chat" },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", label: "Qwen2.5 Coder 32B", adapter: "workers-ai", kind: "text", capabilities: ["code", "chat"], license: "Apache-2.0", attribution: "Qwen (Alibaba Cloud)", source: "free", format: "chat" },
  { id: "@cf/qwen/qwq-32b", label: "QwQ 32B (razonamiento)", adapter: "workers-ai", kind: "text", capabilities: ["reasoning"], license: "Apache-2.0", attribution: "Qwen (Alibaba Cloud)", source: "free", format: "chat" },
  { id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", label: "DeepSeek R1 Distill 32B", adapter: "workers-ai", kind: "text", capabilities: ["reasoning"], license: "MIT", attribution: "DeepSeek", source: "free", format: "chat" },
  { id: "@cf/openai/gpt-oss-120b", label: "gpt-oss 120B", adapter: "workers-ai", kind: "text", capabilities: ["reasoning", "chat", "code"], license: "Apache-2.0", attribution: "OpenAI (open-weight)", source: "free", format: "responses" },

  // --- Texto · Claude (créditos de la plataforma, solo Pro) ---
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", adapter: "anthropic", kind: "text", capabilities: ["chat", "code", "reasoning", "vision"], license: "Servicio comercial (API de Anthropic)", source: "platform" },
  { id: "claude-opus-5", label: "Claude Opus 5", adapter: "anthropic", kind: "text", capabilities: ["chat", "code", "reasoning", "vision"], license: "Servicio comercial (API de Anthropic)", source: "platform" },

  // --- Texto · OpenAI (solo con la API del usuario) ---
  { id: "gpt-5-mini", label: "GPT-5 mini (tu API)", adapter: "openai", kind: "text", capabilities: ["chat", "code", "reasoning", "vision"], license: "Servicio comercial (tu cuenta de OpenAI)", source: "user" },

  // --- Texto · Google Gemini y Groq (claves gratuitas del usuario, API compatible con OpenAI) ---
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (tu clave)", adapter: "openai", kind: "text", capabilities: ["chat", "code", "reasoning", "vision"], license: "Servicio comercial (tu cuenta de Google AI Studio)", source: "user" },
  { id: "gemini-flash-latest", label: "Gemini Flash · última (tu clave)", adapter: "openai", kind: "text", capabilities: ["chat", "code", "reasoning", "vision"], license: "Servicio comercial (tu cuenta de Google AI Studio)", source: "user" },
  { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite · última (tu clave)", adapter: "openai", kind: "text", capabilities: ["chat", "code", "reasoning", "vision"], license: "Servicio comercial (tu cuenta de Google AI Studio)", source: "user" },
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B · Groq (tu clave)", adapter: "openai", kind: "text", capabilities: ["chat", "code", "reasoning"], license: "Llama 3.3 Community License (servicio de Groq)", source: "user" },
  { id: "openai/gpt-oss-120b", label: "gpt-oss 120B · Groq (tu clave)", adapter: "openai", kind: "text", capabilities: ["chat", "code", "reasoning"], license: "Apache-2.0 (servicio de Groq)", source: "user" },
  { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B · Groq (tu clave)", adapter: "openai", kind: "text", capabilities: ["chat", "code"], license: "Llama 3.1 Community License (servicio de Groq)", source: "user" },

  // --- Imagen · Workers AI ---
  { id: "@cf/black-forest-labs/flux-1-schnell", label: "FLUX.1 [schnell]", adapter: "workers-ai", kind: "image", capabilities: ["t2i"], license: "Apache-2.0", attribution: "Black Forest Labs", source: "free", format: "flux", maxSize: 1024 },
  { id: "@cf/bytedance/stable-diffusion-xl-lightning", label: "SDXL Lightning", adapter: "workers-ai", kind: "image", capabilities: ["t2i"], license: "CreativeML Open RAIL++-M", attribution: "ByteDance · Stability AI", source: "free", format: "sd", maxSize: 1024, notes: "Licencia con restricciones de uso (OpenRAIL): prohibido usarla para fines dañinos o ilegales." },
  { id: "@cf/stabilityai/stable-diffusion-xl-base-1.0", label: "Stable Diffusion XL", adapter: "workers-ai", kind: "image", capabilities: ["t2i"], license: "CreativeML Open RAIL++-M", attribution: "Stability AI", source: "free", format: "sd", maxSize: 2048, notes: "Licencia con restricciones de uso (OpenRAIL)." },
  { id: "@cf/lykon/dreamshaper-8-lcm", label: "DreamShaper 8 LCM", adapter: "workers-ai", kind: "image", capabilities: ["t2i"], license: "CreativeML Open RAIL-M", attribution: "Lykon", source: "free", format: "sd", maxSize: 1024, notes: "Licencia con restricciones de uso (OpenRAIL)." },

  // --- Imagen · OpenAI (solo con la API del usuario) ---
  { id: "gpt-image-1", label: "GPT Image (tu API)", adapter: "openai", kind: "image", capabilities: ["t2i", "i2i", "inpaint"], license: "Servicio comercial (tu cuenta de OpenAI)", source: "user", maxSize: 1536 },
];

export const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

/** Modelos de cada proveedor externo gratuito, en orden de preferencia (si uno no existe o falla, el siguiente). */
export const EXT_MODELS: Record<"gemini" | "groq", string[]> = {
  // Google retira modelos con frecuencia: si uno da 404 se aparta 6 h y se usa el siguiente. Cada modelo tiene su propio cupo gratis.
  gemini: ["gemini-3.8-flash", "gemini-flash-latest", "gemini-flash-lite-latest"],
  groq: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant"],
};

/** Cadena de respaldo gratuita por capacidad (orden = preferencia). */
export const FREE_CHAINS: Record<Capability, string[]> = {
  chat: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/meta/llama-3.1-8b-instruct-fp8"],
  code: ["@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8"],
  reasoning: ["@cf/openai/gpt-oss-120b", "@cf/qwen/qwq-32b", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
  vision: ["@cf/mistralai/mistral-small-3.1-24b-instruct"],
  t2i: ["@cf/black-forest-labs/flux-1-schnell", "@cf/bytedance/stable-diffusion-xl-lightning", "@cf/lykon/dreamshaper-8-lcm", "@cf/stabilityai/stable-diffusion-xl-base-1.0"],
  // Workers AI no ofrece a esta cuenta modelos imagen→imagen ni inpainting (SD 1.5 img2img/inpainting
  // devuelven «account not allowed»; SDXL base no acepta imagen de entrada). Sin la API del usuario,
  // imagen→imagen y variaciones se hacen por reinterpretación (visión + texto→imagen) y el upscale en el navegador.
  i2i: [],
  inpaint: [],
};

export function publicModel(m: ModelInfo) {
  const { format: _f, ...rest } = m;
  return rest;
}
