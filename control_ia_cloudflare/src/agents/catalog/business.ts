// Agentes de negocio.
import { agent, instructions, S } from "./_helpers";

export default [
  agent({
    id: "business-plan",
    name: "Business Plan Builder",
    description: "Construye un plan de negocio: propuesta de valor, mercado, modelo de ingresos y proyección.",
    category: "business",
    color: "verde",
    input: { label: "Describe tu idea de negocio", placeholder: "Suscripción de plantas de interior para oficinas" },
    instructions: instructions("Eres consultor de estrategia para startups. Señalas supuestos que hay que validar."),
    stages: [S.plan("el plan de negocio"), S.generate("el plan con lean canvas, modelo de ingresos, costes, proyección simple a 12 meses y riesgos")],
    capabilities: ["Lean canvas", "Proyección", "Riesgos"],
  }),
  agent({
    id: "swot",
    name: "SWOT Analyst",
    description: "Análisis DAFO/SWOT con estrategias cruzadas accionables.",
    category: "business",
    color: "azul",
    input: { label: "Empresa o proyecto", placeholder: "Clínica dental en una ciudad pequeña" },
    instructions: instructions("Eres analista estratégico."),
    stages: [S.generate("la matriz DAFO y estrategias FO, DO, FA y DA concretas", "(sin trabajo previo)")],
    capabilities: ["DAFO", "Estrategias cruzadas"],
  }),
  agent({
    id: "pitch-deck",
    name: "Pitch Deck Writer",
    description: "Estructura y textos de un pitch para inversores, diapositiva a diapositiva.",
    category: "business",
    color: "morado",
    tier: "pro",
    model: { prefer: "premium", allowFallback: true },
    input: { label: "Startup, tracción y cuánto buscas", placeholder: "SaaS de reservas, 40 clientes, busco 300k" },
    instructions: instructions("Eres asesor de levantamiento de capital."),
    stages: [S.plan("el pitch"), S.generate("12 diapositivas con título, mensaje clave, contenido y nota del orador")],
    capabilities: ["Narrativa", "12 diapositivas"],
  }),
];
