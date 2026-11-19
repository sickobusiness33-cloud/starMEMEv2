// Agentes de finanzas: solo análisis educativo; no acceden a cuentas ni mueven dinero.
import { agent, instructions, method, S } from "./_helpers";

const NOTE = "No es asesoramiento financiero profesional. No accedes a cuentas bancarias, wallets ni realizas operaciones.";

export default [
  agent({
    id: "budget-planner",
    name: "Budget Planner",
    description: "Organiza tus ingresos y gastos en un presupuesto mensual con recomendaciones de ahorro.",
    category: "finance",
    color: "verde",
    input: { label: "Ingresos y gastos", placeholder: "Sueldo 1.800, alquiler 700, comida 300…" },
    instructions: instructions("Eres un planificador financiero personal prudente.", NOTE),
    stages: [S.generate("un presupuesto en tabla, porcentaje por categoría, regla 50/30/20 comparada y 5 recomendaciones", "(sin trabajo previo)")],
    capabilities: ["Presupuesto", "Ahorro"],
  }),
  agent({
    id: "finance-analyst",
    name: "Finance Analyst",
    description: "Analiza estados financieros o datos de una empresa: rentabilidad, liquidez, endeudamiento.",
    category: "finance",
    color: "azul",
    tier: "pro",
    model: { prefer: "premium", allowFallback: true },
    input: { label: "Pega los datos financieros", placeholder: "Ingresos, EBITDA, deuda, caja…" },
    instructions: instructions("Eres analista financiero. Calculas ratios y explicas qué significan.", NOTE),
    stages: [S.plan("el análisis financiero"), S.analyze("los ratios de rentabilidad, liquidez y solvencia con los datos dados", "{{input}}"), S.generate("el informe con ratios, interpretación, riesgos y preguntas que faltarían por responder")],
    capabilities: ["Ratios", "Interpretación", "Riesgos"],
    source: method("FinRobot", "AI4Finance-Foundation/FinRobot", "Apache-2.0"),
  }),
  agent({
    id: "invoice-helper",
    name: "Invoice & Pricing Helper",
    description: "Calcula precios, márgenes e IVA y redacta presupuestos para clientes.",
    category: "finance",
    color: "naranja",
    input: { label: "Servicio, costes y precio objetivo", placeholder: "Diseño web, 20 h a 30 €/h, margen 40 %, IVA 21 %" },
    instructions: instructions("Eres un asesor de precios para autónomos y pymes.", NOTE),
    stages: [S.generate("el cálculo detallado (coste, margen, IVA, total) y un texto de presupuesto listo para enviar", "(sin trabajo previo)")],
    capabilities: ["Márgenes", "IVA", "Presupuestos"],
  }),
];
