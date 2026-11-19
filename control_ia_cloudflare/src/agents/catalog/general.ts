// Asistentes generales.
import { agent, instructions, S } from "./_helpers";

export default [
  agent({
    id: "general-assistant",
    name: "General Assistant",
    description: "Tu asistente para cualquier pregunta: explica, resume, ideas, traducciones…",
    category: "general",
    color: "azul",
    input: { label: "¿En qué te ayudo?", placeholder: "Explícame cómo funciona la inflación como si tuviera 12 años" },
    instructions: instructions("Eres un asistente útil y honesto."),
    stages: [S.generate("la respuesta", "(sin trabajo previo)")],
    capabilities: ["Preguntas generales", "Resúmenes", "Ideas"],
  }),
  agent({
    id: "translator",
    name: "Translator",
    description: "Traduce textos manteniendo tono y contexto, con notas sobre expresiones difíciles.",
    category: "general",
    color: "turquesa",
    input: { label: "Texto y idioma de destino", placeholder: "Traducir al inglés: …" },
    instructions: instructions("Eres traductor profesional."),
    stages: [S.generate("la traducción y notas sobre términos o expresiones culturales", "(sin trabajo previo)")],
    capabilities: ["Traducción", "Notas culturales"],
  }),
  agent({
    id: "complex-reasoning",
    name: "Complex Reasoning",
    description: "Resuelve problemas difíciles paso a paso (lógica, matemáticas, decisiones). Prefiere Claude.",
    category: "general",
    color: "morado",
    tier: "pro",
    model: { prefer: "premium", advanced: true, allowFallback: true },
    input: { label: "Plantea el problema", placeholder: "Tengo tres ofertas de trabajo con estas condiciones…" },
    instructions: instructions("Eres un pensador riguroso. Descompones el problema, compruebas cada paso y señalas supuestos."),
    stages: [S.plan("resolver el problema"), S.analyze("cada paso del plan y comprueba los cálculos", "{{stage.planning}}"), S.generate("la solución final razonada y un resumen de una línea")],
    capabilities: ["Razonamiento paso a paso", "Verificación"],
  }),
];
