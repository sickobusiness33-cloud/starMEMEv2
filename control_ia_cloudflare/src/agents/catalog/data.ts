// Agentes de análisis de datos.
import { agent, instructions, method, S } from "./_helpers";

export default [
  agent({
    id: "data-analyst",
    name: "Data Analyst",
    description: "Pega una tabla o CSV y obtén estadísticas, tendencias, anomalías y conclusiones.",
    category: "data",
    color: "turquesa",
    input: { label: "Pega tus datos (CSV o tabla)", placeholder: "mes,ventas\nenero,120\nfebrero,98…" },
    instructions: instructions("Eres un analista de datos. Calculas con cuidado y muestras los cálculos clave. Si los datos son insuficientes, lo dices."),
    stages: [S.plan("analizar los datos"), S.generate("estadísticas descriptivas, tendencias, anomalías, conclusiones y 3 gráficos recomendados (qué eje y por qué)")],
    capabilities: ["Estadística descriptiva", "Anomalías", "Conclusiones"],
    source: method("TaskWeaver", "microsoft/TaskWeaver", "MIT"),
  }),
  agent({
    id: "survey-analyzer",
    name: "Survey Analyzer",
    description: "Agrupa respuestas abiertas de encuestas en temas y mide su frecuencia y sentimiento.",
    category: "data",
    color: "morado",
    input: { label: "Pega las respuestas (una por línea)", placeholder: "Me encanta la app…\nEs lenta al cargar…" },
    instructions: instructions("Eres un investigador de usuarios."),
    stages: [S.generate("temas principales con número de menciones, sentimiento, citas representativas y recomendaciones", "(sin trabajo previo)")],
    capabilities: ["Clustering de temas", "Sentimiento"],
  }),
  agent({
    id: "kpi-dashboard-designer",
    name: "KPI Dashboard Designer",
    description: "Define los KPIs, fórmulas y el diseño de un cuadro de mando para tu negocio.",
    category: "data",
    color: "azul",
    input: { label: "Describe tu negocio y objetivos", placeholder: "E-commerce de ropa, objetivo crecer recurrencia" },
    instructions: instructions("Eres consultor de business intelligence."),
    stages: [S.plan("diseñar el cuadro de mando"), S.generate("lista de KPIs con fórmula, fuente de datos, frecuencia y disposición del dashboard")],
    capabilities: ["KPIs", "Fórmulas", "Diseño de dashboard"],
  }),
];
