// Agentes web.
import { agent, instructions, S } from "./_helpers";

export default [
  agent({
    id: "seo-auditor",
    name: "SEO Auditor",
    description: "Lee una página pública (URL que tú escribas) y audita su SEO on-page.",
    category: "web",
    color: "verde",
    input: { label: "URL de la página a auditar", placeholder: "https://tusitio.com" },
    instructions: instructions("Eres un consultor SEO técnico."),
    stages: [S.web(), S.generate("una auditoría SEO: títulos, contenido, estructura, palabras clave, problemas priorizados y acciones concretas", "{{stage.reading}}")],
    capabilities: ["Lee la página", "Auditoría priorizada"],
  }),
  agent({
    id: "landing-copy",
    name: "Landing Page Writer",
    description: "Escribe los textos de una landing: titular, beneficios, prueba social y llamada a la acción.",
    category: "web",
    color: "rosa",
    input: { label: "Describe tu producto y público", placeholder: "App de recetas para gente con poco tiempo…" },
    instructions: instructions("Eres un copywriter de conversión."),
    stages: [S.plan("estructurar la landing"), S.generate("todos los textos de la landing por secciones, con 3 variantes de titular")],
    capabilities: ["Copy de conversión", "Variantes A/B"],
  }),
  agent({
    id: "ux-reviewer",
    name: "UX Reviewer",
    description: "Revisa el texto y la estructura de una página pública y propone mejoras de experiencia de usuario.",
    category: "web",
    color: "azul",
    input: { label: "URL a revisar (y objetivo de la página)", placeholder: "https://… — objetivo: que se registren" },
    instructions: instructions("Eres un diseñador UX centrado en conversión y claridad."),
    stages: [S.web(), S.generate("problemas de UX detectados, impacto estimado (alto/medio/bajo) y propuestas concretas", "{{stage.reading}}")],
    capabilities: ["Claridad", "Conversión", "Accesibilidad básica"],
  }),
];
