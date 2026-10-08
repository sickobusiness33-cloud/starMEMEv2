// Agentes de marketing.
import { agent, instructions, S } from "./_helpers";

export default [
  agent({
    id: "marketing-strategist",
    name: "Marketing Strategist",
    description: "Crea un plan de marketing: público, posicionamiento, canales, mensajes y calendario de 30 días.",
    category: "marketing",
    color: "naranja",
    input: { label: "Producto, público y objetivo", placeholder: "Curso online de cocina, público 25-40, objetivo 500 ventas" },
    instructions: instructions("Eres un estratega de marketing práctico, orientado a resultados medibles."),
    stages: [S.plan("el plan de marketing"), S.generate("el plan completo con KPIs y calendario de 30 días en tabla")],
    capabilities: ["Posicionamiento", "Canales", "Calendario"],
  }),
  agent({
    id: "ad-copy",
    name: "Ad Copy Generator",
    description: "Genera anuncios para Google, Meta y LinkedIn con variantes para testear.",
    category: "marketing",
    color: "rosa",
    input: { label: "¿Qué anuncias y a quién?", placeholder: "Software de facturación para autónomos" },
    instructions: instructions("Eres un especialista en anuncios de pago. Respetas los límites de caracteres de cada plataforma."),
    stages: [S.generate("5 variantes por plataforma (Google, Meta, LinkedIn) respetando límites de caracteres, con el ángulo de cada una", "(sin trabajo previo)")],
    capabilities: ["Variantes A/B", "Límites por plataforma"],
  }),
  agent({
    id: "competitor-analysis",
    name: "Competitor Analysis",
    description: "Compara tu producto con competidores (lee sus webs si pegas las URLs) y encuentra huecos de mercado.",
    category: "marketing",
    color: "azul",
    tier: "pro",
    model: { prefer: "premium", allowFallback: true },
    input: { label: "Tu producto y URLs de competidores", placeholder: "Mi app: … Competidores: https://… https://…" },
    instructions: instructions("Eres un analista de mercado."),
    stages: [S.web(), S.analyze("a los competidores: propuesta de valor, precio, público y debilidades", "{{stage.reading}}"), S.generate("una matriz comparativa, huecos de mercado y 5 oportunidades de diferenciación")],
    capabilities: ["Lee webs de competidores", "Matriz comparativa"],
  }),
];
