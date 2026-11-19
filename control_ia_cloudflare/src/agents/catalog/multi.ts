// Flujos multiagente: varios robots colaboran. Solo análisis y contenido; ninguna
// acción externa ni financiera real. Los subagentes se ejecutan en paralelo y un
// agente final integra sus resultados.
import { agent, instructions, method } from "./_helpers";

export default [
  agent({
    id: "investment-committee",
    name: "Investment Committee",
    description: "Un comité de robots (datos, investigación y riesgo) analiza una idea de inversión y un robot final da la conclusión.",
    category: "multi",
    color: "naranja",
    tier: "pro",
    model: { prefer: "premium", allowFallback: true },
    input: { label: "Idea de inversión y datos", placeholder: "Comprar acciones de una energética europea, datos: …" },
    instructions: instructions("Eres el presidente de un comité de inversión. Integras las opiniones y das una conclusión equilibrada. No es asesoramiento financiero."),
    stages: [
      { id: "planning", label: "Master plan", kind: "llm", maxTokens: 300, prompt: "Idea:\n{{input}}\n\nDefine en 3 líneas qué debe analizar cada miembro del comité (datos, investigación, riesgo)." },
      { id: "team", label: "Committee", kind: "agents", agents: ["data-analyst", "research-agent", "risk-reviewer"], prompt: "Idea de inversión:\n{{input}}\n\nEncargo del presidente:\n{{stage.planning}}" },
      { id: "generating", label: "Final analysis", kind: "llm", prompt: "Idea:\n{{input}}\n\nInformes del comité:\n{{stage.team}}\n\nRedacta el análisis final: consenso, desacuerdos, riesgos principales, conclusión y aviso de que no es asesoramiento financiero." },
    ],
    capabilities: ["3 robots en paralelo", "Síntesis final", "Solo análisis"],
    source: method("TradingAgents", "TauricResearch/TradingAgents", "Apache-2.0"),
  }),
  agent({
    id: "content-studio",
    name: "Content Studio",
    description: "Research → Writer → Editor: un equipo de robots investiga, escribe y revisa un artículo.",
    category: "multi",
    color: "rosa",
    tier: "pro",
    model: { prefer: "premium", allowFallback: true },
    input: { label: "Tema del artículo", placeholder: "Guía para empezar con la jardinería urbana" },
    instructions: instructions("Diriges un estudio de contenidos."),
    stages: [
      { id: "team", label: "Research + Writing", kind: "agents", agents: ["research-agent", "blog-writer"], prompt: "{{input}}" },
      { id: "analyzing", label: "Editor", kind: "llm", maxTokens: 900, prompt: "Material del equipo:\n{{stage.team}}\n\nComo editor, integra la investigación en el borrador y señala qué corregir." },
      { id: "generating", label: "Reviewer", kind: "llm", prompt: "Tema: {{input}}\n\nNotas del editor:\n{{stage.analyzing}}\n\nMaterial:\n{{stage.team}}\n\nEntrega el artículo final corregido, con fuentes." },
    ],
    capabilities: ["Investigación + redacción", "Edición", "Revisión"],
    source: method("CrewAI", "crewAIInc/crewAI", "MIT"),
  }),
  agent({
    id: "product-squad",
    name: "Product Squad",
    description: "Product manager, arquitecto y marketer definen juntos un producto: requisitos, diseño técnico y lanzamiento.",
    category: "multi",
    color: "morado",
    tier: "pro",
    model: { prefer: "premium", allowFallback: true },
    input: { label: "Idea de producto", placeholder: "App para compartir coche entre vecinos" },
    instructions: instructions("Coordinas un equipo de producto."),
    stages: [
      { id: "team", label: "Squad", kind: "agents", agents: ["task-planner", "advanced-coding", "marketing-strategist"], prompt: "Producto a definir:\n{{input}}\n\nAporta tu parte (plan, diseño técnico o lanzamiento)." },
      { id: "generating", label: "PRD", kind: "llm", prompt: "Producto: {{input}}\n\nAportaciones del equipo:\n{{stage.team}}\n\nRedacta un documento de producto (PRD): problema, usuarios, requisitos, arquitectura, plan de lanzamiento y riesgos." },
    ],
    capabilities: ["PM + arquitecto + marketing", "PRD final"],
    source: method("MetaGPT", "geekan/MetaGPT", "MIT"),
  }),
  agent({
    id: "risk-reviewer",
    name: "Risk Reviewer",
    description: "Identifica riesgos de cualquier plan o decisión y propone mitigaciones.",
    category: "multi",
    color: "rosa",
    input: { label: "Plan o decisión", placeholder: "Dejar mi trabajo para montar una tienda online" },
    instructions: instructions("Eres analista de riesgos."),
    stages: [{ id: "generating", label: "Risk review", kind: "llm", prompt: "{{input}}\n\nEnumera los riesgos (probabilidad, impacto), señales de alerta y mitigaciones concretas." }],
    capabilities: ["Matriz de riesgos", "Mitigaciones"],
  }),
];
