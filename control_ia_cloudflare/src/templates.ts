// Plantillas de proyecto: presets opcionales (nunca obligatorios). Rellenan el
// objetivo sugerido, instrucciones y memoria inicial; Kairo decide agentes y modelos.

export interface ProjectTemplate {
  id: string;
  label: string;
  icon: string;
  color: string;
  objective: string;
  instructions: string;
  memory: { kind: "instruction" | "preference" | "fact"; content: string }[];
}

export const TEMPLATES: ProjectTemplate[] = [
  { id: "software", label: "Software Development", icon: "coding", color: "morado", objective: "Diseñar, construir y mejorar una aplicación.",
    instructions: "Prioriza código claro, seguro y probado. Explica los cambios y sus riesgos.",
    memory: [{ kind: "preference", content: "Entregar código completo y listo para copiar, con pasos para probarlo." }] },
  { id: "marketing", label: "Marketing", icon: "marketing", color: "rosa", objective: "Planificar y ejecutar acciones de marketing.",
    instructions: "Piensa en el público objetivo, el mensaje y métricas medibles.",
    memory: [{ kind: "preference", content: "Propuestas accionables con calendario y KPIs." }] },
  { id: "research", label: "Research", icon: "research", color: "azul", objective: "Investigar un tema en profundidad con fuentes.",
    instructions: "Cita fuentes, separa hechos de opiniones y señala lo que no se sabe.",
    memory: [{ kind: "preference", content: "Informes estructurados con conclusiones al principio." }] },
  { id: "content", label: "Content", icon: "writing", color: "naranja", objective: "Crear contenido (artículos, posts, guiones, imágenes).",
    instructions: "Tono cercano y claro. Adapta el formato a cada canal.",
    memory: [{ kind: "preference", content: "Incluir título, gancho y llamada a la acción." }] },
  { id: "business", label: "Business", icon: "business", color: "verde", objective: "Definir y hacer crecer un negocio.",
    instructions: "Enfoque práctico: números, riesgos y próximos pasos.",
    memory: [{ kind: "preference", content: "Resúmenes ejecutivos de una página cuando sea posible." }] },
  { id: "data", label: "Data Analysis", icon: "data", color: "turquesa", objective: "Analizar datos y extraer conclusiones.",
    instructions: "Explica la metodología y los supuestos. No inventes datos.",
    memory: [{ kind: "preference", content: "Tablas y cifras claras; indicar el nivel de confianza." }] },
  { id: "automation", label: "AI Automation", icon: "automation", color: "morado", objective: "Automatizar procesos con IA y scripts.",
    instructions: "Diseña flujos simples, con manejo de errores y pasos de verificación.",
    memory: [{ kind: "preference", content: "Diagramas de flujo en texto y scripts comentados." }] },
  { id: "assistant", label: "Personal Assistant", icon: "productivity", color: "azul", objective: "Organizar tareas, correos y planes personales.",
    instructions: "Respuestas breves y accionables.",
    memory: [{ kind: "preference", content: "Listas de tareas con prioridad y fecha." }] },
  { id: "custom", label: "Custom", icon: "general", color: "azul", objective: "", instructions: "", memory: [] },
];

export const TEMPLATE_MAP = new Map(TEMPLATES.map((t) => [t.id, t]));
