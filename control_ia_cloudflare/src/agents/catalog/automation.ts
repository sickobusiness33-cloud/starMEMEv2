// Agentes de automatización: diseñan flujos; NO los ejecutan ni se conectan a cuentas.
import { agent, instructions, S } from "./_helpers";

export default [
  agent({
    id: "workflow-designer",
    name: "Workflow Designer",
    description: "Diseña una automatización paso a paso (disparador, acciones, condiciones) para la herramienta que uses.",
    category: "automation",
    color: "morado",
    input: { label: "¿Qué quieres automatizar?", placeholder: "Cuando llegue un formulario, guardarlo en una hoja y avisarme por email" },
    instructions: instructions("Eres consultor de automatización. Diseñas, no ejecutas: el usuario implementa el flujo en su herramienta."),
    stages: [S.plan("el flujo"), S.generate("el flujo detallado (disparador, pasos, condiciones, manejo de errores) y cómo montarlo en Make, Zapier o código")],
    capabilities: ["Diseño de flujos", "Manejo de errores"],
  }),
  agent({
    id: "script-generator",
    model: { prefer: "free", allowFallback: true, capability: "code" },
    name: "Script Generator",
    description: "Genera scripts (Python, Bash, Apps Script) para automatizar tareas repetitivas. Tú los revisas y ejecutas.",
    category: "automation",
    color: "azul",
    input: { label: "Tarea a automatizar y entorno", placeholder: "Renombrar fotos por fecha en una carpeta, en Windows" },
    instructions: instructions("Escribes scripts seguros: nunca borran sin confirmación y explican qué hacen. Control IA no ejecuta los scripts."),
    stages: [S.generate("el script completo, cómo ejecutarlo, qué hace cada parte y precauciones", "(sin trabajo previo)")],
    capabilities: ["Scripts", "Instrucciones de uso"],
  }),
  agent({
    id: "regex-builder",
    model: { prefer: "free", allowFallback: true, capability: "code" },
    name: "Regex & Formula Builder",
    description: "Crea expresiones regulares y fórmulas de Excel/Sheets explicadas.",
    category: "automation",
    color: "verde",
    input: { label: "¿Qué quieres encontrar o calcular?", placeholder: "Extraer emails de un texto / sumar ventas por mes" },
    instructions: instructions("Eres experto en expresiones regulares y hojas de cálculo."),
    stages: [S.generate("la expresión o fórmula, explicación de cada parte y 3 ejemplos de prueba", "(sin trabajo previo)")],
    capabilities: ["Regex", "Fórmulas"],
  }),
];
