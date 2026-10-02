// Agentes de imagen: generan imágenes con FLUX.1 [schnell] (Apache-2.0) en Workers AI.
import { agent, instructions } from "./_helpers";

export default [
  agent({
    id: "image-generator",
    name: "Image Generator",
    description: "Genera una imagen a partir de tu descripción, gratis, con un modelo abierto en Cloudflare.",
    category: "image",
    color: "naranja",
    input: { label: "Describe la imagen", placeholder: "Un robot amigable regando plantas en una azotea al atardecer" },
    instructions: instructions("Eres director de arte. Conviertes ideas en prompts visuales precisos."),
    stages: [
      { id: "planning", label: "Prompting", kind: "llm", maxTokens: 250, prompt: "Descripción del usuario:\n{{input}}\n\nEscribe en inglés un único prompt de imagen detallado (sujeto, estilo, iluminación, composición, colores), máximo 70 palabras. Solo el prompt." },
      { id: "generating", label: "Rendering", kind: "tool", tool: "image_generate", from: "planning" },
    ],
    capabilities: ["Imagen 1024px", "Prompt mejorado automáticamente"],
  }),
  agent({
    id: "logo-concepts",
    name: "Logo Concepts",
    description: "Propone conceptos de logotipo y genera una imagen del concepto elegido.",
    category: "image",
    color: "morado",
    input: { label: "Marca y valores", placeholder: "Cafetería 'Luna', cálida, artesanal, minimalista" },
    instructions: instructions("Eres diseñador de identidad visual."),
    stages: [
      { id: "planning", label: "Concepts", kind: "llm", maxTokens: 500, prompt: "Marca:\n{{input}}\n\nPropón 3 conceptos de logotipo (idea, forma, colores, tipografía). Termina con una línea que empiece por PROMPT: con un prompt de imagen en inglés para el mejor concepto (logo plano, fondo blanco)." },
      { id: "generating", label: "Rendering", kind: "tool", tool: "image_generate", from: "planning" },
    ],
    capabilities: ["3 conceptos", "Render del mejor"],
  }),
  agent({
    id: "image-prompt-engineer",
    name: "Image Prompt Engineer",
    description: "Escribe prompts optimizados para Midjourney, DALL·E, Stable Diffusion o FLUX.",
    category: "image",
    color: "azul",
    input: { label: "¿Qué imagen quieres conseguir?", placeholder: "Foto de producto de unas zapatillas flotando" },
    instructions: instructions("Eres experto en prompts de generación de imágenes."),
    stages: [{ id: "generating", label: "Generating", kind: "llm", prompt: "Objetivo:\n{{input}}\n\nEscribe prompts optimizados para 4 generadores (Midjourney, DALL·E, Stable Diffusion, FLUX) con parámetros recomendados y un prompt negativo." }],
    capabilities: ["Prompts por herramienta", "Prompt negativo"],
  }),
];
