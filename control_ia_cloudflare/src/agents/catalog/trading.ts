// Agentes de trading: SOLO análisis educativo. Nunca operan ni acceden a cuentas o wallets.
import { agent, instructions, method, S } from "./_helpers";

const RISK = "No das asesoramiento financiero personalizado ni ejecutas operaciones. Recuerda siempre que el trading implica riesgo de pérdida total. No inventes precios: trabaja solo con los datos que te dé el usuario.";

export default [
  agent({
    id: "trading-analyst",
    name: "Trading Analyst",
    description: "Analiza el escenario de un activo con los datos que tú aportes: tendencia, niveles, riesgos y posibles planes.",
    category: "trading",
    color: "verde",
    input: { label: "Activo y datos que tengas", placeholder: "Ej.: BTC, precio 64.000, soporte 60k, resistencia 68k, volumen subiendo…" },
    instructions: instructions("Eres un analista técnico educativo.", RISK),
    stages: [S.plan("analizar el activo"), S.generate("un análisis con escenario alcista, bajista y neutral, niveles relevantes, riesgos y un recordatorio de riesgo", "{{stage.planning}}")],
    capabilities: ["Escenarios", "Gestión de riesgo", "Sin ejecución de órdenes"],
  }),
  agent({
    id: "advanced-trading",
    name: "Advanced Trading Analysis",
    description: "Debate alcista vs bajista entre analistas y una evaluación de riesgo final. Prefiere Claude.",
    category: "trading",
    color: "naranja",
    tier: "pro",
    model: { prefer: "premium", advanced: true, allowFallback: true },
    input: { label: "Activo, contexto y datos", placeholder: "Pega datos, noticias o tu tesis" },
    instructions: instructions("Diriges un equipo de análisis: analista fundamental, técnico, alcista, bajista y gestor de riesgo.", RISK),
    stages: [
      { id: "analyzing", label: "Bull vs Bear", kind: "llm", maxTokens: 1200, prompt: "Datos del usuario:\n{{input}}\n\nEscribe el argumento de un analista ALCISTA y después el de un analista BAJISTA, cada uno con sus mejores razones basadas solo en los datos aportados." },
      { id: "risk", label: "Risk review", kind: "llm", maxTokens: 700, prompt: "Debate:\n{{stage.analyzing}}\n\nComo gestor de riesgo, evalúa qué argumentos son más sólidos, qué riesgos no se han considerado y qué tamaño de posición sería prudente en términos generales." },
      S.generate("un informe final: resumen del debate, conclusión equilibrada, riesgos y aviso de que no es asesoramiento financiero", "{{stage.analyzing}}\n\n{{stage.risk}}"),
    ],
    capabilities: ["Debate alcista/bajista", "Revisión de riesgo", "Solo análisis"],
    source: method("TradingAgents", "TauricResearch/TradingAgents", "Apache-2.0"),
  }),
  agent({
    id: "trade-journal",
    name: "Trade Journal Coach",
    description: "Revisa tu diario de operaciones y encuentra patrones, errores repetidos y mejoras de disciplina.",
    category: "trading",
    color: "azul",
    input: { label: "Pega tu diario de operaciones", placeholder: "Fecha, activo, entrada, salida, motivo, resultado…" },
    instructions: instructions("Eres un coach de disciplina de trading.", RISK),
    stages: [S.plan("revisar el diario"), S.generate("patrones detectados, errores repetidos, métricas simples calculadas con los datos dados y 5 reglas de mejora")],
    capabilities: ["Patrones de comportamiento", "Reglas de disciplina"],
  }),
];
