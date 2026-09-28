// Catálogo de modelos del MODEL ROUTER.
//
// Cada modelo declara su proveedor (adapter), capacidades, licencia y
// atribución. Añadir un modelo = añadir una entrada aquí (y, si es de un
// proveedor nuevo, un adapter en ./adapters). Solo se incluyen modelos con
// licencia que permite uso comercial; los que añaden restricciones de uso
// (OpenRAIL) se muestran con su aviso.

export type Capability =
  | "chat" | "code" | "reasoning" | "vision" // texto
  | "t2i" | "i2i" | "inpaint" | "upscale"; // imagen

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
  format?: "chat" | "responses" | "flux" | "sd" | "sd-img2img" | "sd-inpaint";
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

  // --- Imagen · Workers AI ---
  { id: "@cf/black-forest-labs/flux-1-schnell", label: "FLUX.1 [schnell]", adapter: "workers-ai", kind: "image", capabilities: ["t2i"], license: "Apache-2.0", attribution: "Black Forest Labs", source: "free", format: "flux", maxSize: 1024 },
  { id: "@cf/bytedance/stable-diffusion-xl-lightning", label: "SDXL Lightning", adapter: "workers-ai", kind: "image", capabilities: ["t2i"], license: "CreativeML Open RAIL++-M", attribution: "ByteDance · Stability AI", source: "free", format: "sd", maxSize: 1024, notes: "Licencia con restricciones de uso (OpenRAIL): prohibido usarla para fines dañinos o ilegales." },
  { id: "@cf/stabilityai/stable-diffusion-xl-base-1.0", label: "Stable Diffusion XL", adapter: "workers-ai", kind: "image", capabilities: ["t2i", "i2i", "upscale"], license: "CreativeML Open RAIL++-M", attribution: "Stability AI", source: "free", format: "sd", maxSize: 2048, notes: "Licencia con restricciones de uso (OpenRAIL)." },
  { id: "@cf/lykon/dreamshaper-8-lcm", label: "DreamShaper 8 LCM", adapter: "workers-ai", kind: "image", capabilities: ["t2i"], license: "CreativeML Open RAIL-M", attribution: "Lykon", source: "free", format: "sd", maxSize: 1024, notes: "Licencia con restricciones de uso (OpenRAIL)." },
  { id: "@cf/runwayml/stable-diffusion-v1-5-img2img", label: "SD 1.5 img2img", adapter: "workers-ai", kind: "image", capabilities: ["i2i"], license: "CreativeML Open RAIL-M", attribution: "Runway · Stability AI", source: "free", format: "sd-img2img", maxSize: 1024, notes: "Licencia con restricciones de uso (OpenRAIL)." },
  { id: "@cf/runwayml/stable-diffusion-v1-5-inpainting", label: "SD 1.5 Inpainting", adapter: "workers-ai", kind: "image", capabilities: ["inpaint"], license: "CreativeML Open RAIL-M", attribution: "Runway · Stability AI", source: "free", format: "sd-inpaint", maxSize: 1024, notes: "Licencia con restricciones de uso (OpenRAIL)." },

  // --- Imagen · OpenAI (solo con la API del usuario) ---
  { id: "gpt-image-1", label: "GPT Image (tu API)", adapter: "openai", kind: "image", capabilities: ["t2i", "i2i"], license: "Servicio comercial (tu cuenta de OpenAI)", source: "user", maxSize: 1536 },
];

export const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

/** Cadena de respaldo gratuita por capacidad (orden = preferencia). */
export const FREE_CHAINS: Record<Capability, string[]> = {
  chat: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/meta/llama-3.1-8b-instruct-fp8"],
  code: ["@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8"],
  reasoning: ["@cf/openai/gpt-oss-120b", "@cf/qwen/qwq-32b", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
  vision: ["@cf/mistralai/mistral-small-3.1-24b-instruct"],
  t2i: ["@cf/black-forest-labs/flux-1-schnell", "@cf/bytedance/stable-diffusion-xl-lightning", "@cf/lykon/dreamshaper-8-lcm", "@cf/stabilityai/stable-diffusion-xl-base-1.0"],
  i2i: ["@cf/runwayml/stable-diffusion-v1-5-img2img", "@cf/stabilityai/stable-diffusion-xl-base-1.0"],
  inpaint: ["@cf/runwayml/stable-diffusion-v1-5-inpainting"],
  upscale: ["@cf/stabilityai/stable-diffusion-xl-base-1.0"],
};

export function publicModel(m: ModelInfo) {
  const { format: _f, ...rest } = m;
  return rest;
}
