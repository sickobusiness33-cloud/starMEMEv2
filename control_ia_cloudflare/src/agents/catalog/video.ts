// Agentes de vídeo: guiones y storyboards (no se genera vídeo en esta versión).
import { agent, instructions, S } from "./_helpers";

export default [
  agent({
    id: "video-script",
    name: "Video Script Writer",
    description: "Guion completo para YouTube o vídeo corporativo con escenas, voz en off y duración.",
    category: "video",
    color: "rosa",
    input: { label: "Tema, duración y plataforma", placeholder: "Tutorial de 5 min sobre cómo invertir en fondos indexados, YouTube" },
    instructions: instructions("Eres guionista audiovisual."),
    stages: [S.plan("la estructura del vídeo"), S.generate("el guion por escenas: tiempo, plano, voz en off y texto en pantalla")],
    capabilities: ["Escenas", "Voz en off", "Tiempos"],
  }),
  agent({
    id: "shorts-ideas",
    name: "Shorts & Reels Ideas",
    description: "Ideas y guiones de vídeos cortos (TikTok, Reels, Shorts) con gancho en los primeros 2 segundos.",
    category: "video",
    color: "naranja",
    input: { label: "Nicho o producto", placeholder: "Entrenador personal online" },
    instructions: instructions("Eres creador de contenido de vídeo corto."),
    stages: [S.generate("10 ideas con gancho, guion de 30 s de las 3 mejores y sugerencias de audio/edición", "(sin trabajo previo)")],
    capabilities: ["Ganchos", "Guiones de 30 s"],
  }),
  agent({
    id: "storyboard",
    name: "Storyboard Artist",
    description: "Convierte un guion en un storyboard plano a plano y genera la imagen del plano clave.",
    category: "video",
    color: "morado",
    input: { label: "Pega el guion o la idea", placeholder: "Anuncio de 15 s de una bebida energética…" },
    instructions: instructions("Eres artista de storyboard."),
    stages: [
      { id: "planning", label: "Shot list", kind: "llm", maxTokens: 700, prompt: "Guion:\n{{input}}\n\nCrea un storyboard: lista de planos (número, encuadre, acción, duración). Termina con una línea que empiece por PROMPT: con un prompt de imagen en inglés del plano más importante." },
      { id: "generating", label: "Key frame", kind: "tool", tool: "image_generate", from: "planning" },
    ],
    capabilities: ["Lista de planos", "Fotograma clave"],
  }),
];
