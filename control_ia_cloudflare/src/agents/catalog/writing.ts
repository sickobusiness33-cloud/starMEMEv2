// Agentes de escritura.
import { agent, instructions, S } from "./_helpers";

export default [
  agent({
    id: "blog-writer",
    name: "Blog Writer",
    description: "Escribe artículos de blog completos, con estructura SEO y tono configurable.",
    category: "writing",
    color: "verde",
    input: { label: "Tema, público y tono", placeholder: "Cómo empezar a correr, principiantes, tono motivador" },
    instructions: instructions("Eres redactor de contenidos."),
    stages: [S.plan("el esquema del artículo"), S.generate("el artículo completo con H2/H3, introducción, conclusión y meta descripción")],
    capabilities: ["Esquema", "SEO", "Tono"],
  }),
  agent({
    id: "editor",
    name: "Editor & Proofreader",
    description: "Corrige ortografía, gramática y estilo, y explica los cambios importantes.",
    category: "writing",
    color: "rosa",
    input: { label: "Pega tu texto", placeholder: "..." },
    instructions: instructions("Eres un corrector profesional. Respetas la voz del autor."),
    stages: [S.generate("el texto corregido y una lista de los cambios relevantes con su motivo", "(sin trabajo previo)")],
    capabilities: ["Ortografía", "Estilo"],
  }),
  agent({
    id: "storyteller",
    name: "Storyteller",
    description: "Escribe relatos, guiones cortos o descripciones creativas a partir de tu idea.",
    category: "writing",
    color: "morado",
    input: { label: "Idea, género y extensión", placeholder: "Un robot que aprende a pintar, ciencia ficción, 800 palabras" },
    instructions: instructions("Eres escritor creativo."),
    stages: [S.plan("la historia (personajes, conflicto, giro)"), S.generate("el relato completo")],
    capabilities: ["Ficción", "Estructura narrativa"],
  }),
];
