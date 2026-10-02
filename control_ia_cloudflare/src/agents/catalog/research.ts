// Agentes de investigación.
import { agent, instructions, method, S } from "./_helpers";

export default [
  agent({
    id: "research-agent",
    name: "Research Agent",
    description: "Investiga un tema en Wikipedia, contrasta la información y te entrega un resumen con fuentes.",
    category: "research",
    color: "azul",
    input: { label: "¿Qué quieres que investigue?", placeholder: "Ej.: impacto de la energía solar en España" },
    instructions: instructions("Eres un investigador riguroso. Resumes, comparas fuentes y señalas lo que no está claro."),
    stages: [S.planQueries("el tema pedido"), S.wiki(), S.analyze("el material encontrado"), S.generate("un informe con resumen ejecutivo, puntos clave y lista de fuentes (con enlaces)")],
    capabilities: ["Busca en Wikipedia (es/en)", "Contrasta fuentes", "Informe con enlaces"],
    source: method("GPT Researcher", "assafelovic/gpt-researcher", "Apache-2.0"),
  }),
  agent({
    id: "deep-research",
    name: "Deep Research",
    description: "Investigación profunda desde varias perspectivas con esquema, argumentos y conclusiones. Prefiere Claude.",
    category: "research",
    color: "morado",
    tier: "pro",
    model: { prefer: "premium", advanced: true, allowFallback: true },
    input: { label: "Tema de investigación profunda", placeholder: "Ej.: estado del arte de las baterías de estado sólido" },
    instructions: instructions("Eres un investigador sénior. Analizas un tema desde varias perspectivas (experto, crítico, usuario, regulador) antes de escribir."),
    stages: [
      S.planQueries("el tema, pensando qué perspectivas y preguntas cubrir"),
      S.wiki(),
      { id: "analyzing", label: "Analyzing", kind: "llm", maxTokens: 1200, prompt: "Tema: {{input}}\n\nMaterial:\n{{stage.researching}}\n\nIdentifica 4 perspectivas relevantes. Para cada una: preguntas clave, lo que dicen las fuentes y lo que falta. Después, un esquema del informe final." },
      S.generate("un informe largo y estructurado siguiendo el esquema: introducción, secciones por perspectiva, debate, conclusiones y fuentes con enlaces", "{{stage.analyzing}}"),
    ],
    capabilities: ["Varias perspectivas", "Esquema previo", "Informe extenso con fuentes"],
    source: method("STORM", "stanford-oval/storm", "MIT"),
  }),
  agent({
    id: "fact-checker",
    name: "Fact Checker",
    description: "Comprueba una afirmación contra Wikipedia y te dice qué está respaldado y qué no.",
    category: "research",
    color: "turquesa",
    input: { label: "Afirmación a verificar", placeholder: "Ej.: La Gran Muralla China se ve desde el espacio" },
    instructions: instructions("Eres un verificador de datos. Clasificas afirmaciones como respaldada, dudosa o falsa, siempre con fuentes."),
    stages: [S.planQueries("verificar la afirmación"), S.wiki(), S.generate("un veredicto (respaldada / dudosa / falsa / no verificable), la explicación y las fuentes", "{{stage.researching}}")],
    capabilities: ["Veredicto claro", "Fuentes citadas"],
  }),
];
