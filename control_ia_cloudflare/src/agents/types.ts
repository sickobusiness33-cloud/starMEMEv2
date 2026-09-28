// Contrato común de todos los agentes (manifiesto declarativo).
//
// Un agente NO es código: es un manifiesto (metadatos + instrucciones + etapas
// + herramientas permitidas). El runtime (runtime.ts) lo ejecuta siempre a
// través del AI Router. Así el catálogo puede crecer a cientos o miles de
// agentes sin cambiar la arquitectura y sin ejecutar código de terceros.

export const CATEGORIES = [
  { id: "trading", label: "Trading" },
  { id: "research", label: "Research" },
  { id: "coding", label: "Coding" },
  { id: "web", label: "Web" },
  { id: "marketing", label: "Marketing" },
  { id: "social", label: "Social Media" },
  { id: "data", label: "Data Analysis" },
  { id: "finance", label: "Finance" },
  { id: "productivity", label: "Productivity" },
  { id: "automation", label: "Automation" },
  { id: "writing", label: "Writing" },
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
  { id: "security", label: "Security" },
  { id: "business", label: "Business" },
  { id: "general", label: "General AI" },
  { id: "multi", label: "Multi-Agent" },
  { id: "browser", label: "Browser Agents" },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]["id"];

/** Herramientas que un agente puede declarar. Ninguna da acceso a secretos, BD ni sistema de archivos. */
export type AgentToolId = "wikipedia_search" | "web_read" | "image_generate";

export type Stage =
  | { id: string; label: string; kind: "llm"; prompt: string; maxTokens?: number }
  | { id: string; label: string; kind: "tool"; tool: AgentToolId; from: string }
  | { id: string; label: string; kind: "agents"; agents: string[]; prompt: string };

export interface AgentSource {
  /** original = diseño propio · method = metodología inspirada en un proyecto (sin copiar código) · external = manifiesto aportado */
  type: "original" | "method" | "external";
  label: string;
  url?: string;
  license: string; // licencia del proyecto de referencia, o "Original (Control IA)"
  attribution?: string;
}

export interface AgentManifest {
  id: string;
  name: string;
  description: string;
  category: CategoryId;
  version: string;
  tier: "free" | "pro";
  color: "azul" | "rosa" | "morado" | "verde" | "turquesa" | "naranja";
  model: {
    prefer: "free" | "premium"; // premium = Claude primero si está disponible
    advanced?: boolean; // usa el modelo avanzado de Claude
    allowFallback: boolean; // si no hay Claude, ¿puede usar el modelo gratuito?
  };
  input: { label: string; placeholder: string };
  instructions: string;
  stages: Stage[];
  tools: AgentToolId[];
  limits?: { maxInputChars?: number; maxOutputTokens?: number };
  capabilities: string[];
  source: AgentSource;
  added: string; // fecha ISO de incorporación al catálogo
}

export const TOOL_INFO: Record<AgentToolId, { label: string; permission: string }> = {
  wikipedia_search: {
    label: "Búsqueda en Wikipedia",
    permission: "Leer Wikipedia (solo lectura; contenido CC BY-SA, se cita la fuente)",
  },
  web_read: {
    label: "Lector de páginas web",
    permission: "Leer únicamente las páginas públicas cuya URL escribas tú (sin JavaScript, sin enviar datos)",
  },
  image_generate: {
    label: "Generación de imágenes",
    permission: "Generar imágenes con un modelo abierto en Cloudflare (FLUX.1 schnell, Apache-2.0)",
  },
};

/** Licencias que permiten reutilizar, modificar y usar comercialmente. */
export const COMPATIBLE_LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0", "Unlicense", "0BSD", "Original (Control IA)"];
