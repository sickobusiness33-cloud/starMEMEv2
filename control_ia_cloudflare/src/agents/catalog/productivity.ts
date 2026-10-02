// Agentes de productividad.
import { agent, instructions, S } from "./_helpers";

export default [
  agent({
    id: "task-planner",
    name: "Task Planner",
    description: "Convierte un objetivo en un plan de tareas priorizadas con tiempos y próximos pasos.",
    category: "productivity",
    color: "azul",
    input: { label: "¿Qué quieres conseguir?", placeholder: "Lanzar mi tienda online en 4 semanas" },
    instructions: instructions("Eres un jefe de proyecto pragmático."),
    stages: [S.plan("dividir el objetivo"), S.generate("un plan semanal con tareas, prioridad (Eisenhower), duración estimada y el primer paso para hoy")],
    capabilities: ["Priorización", "Plan semanal"],
  }),
  agent({
    id: "meeting-notes",
    name: "Meeting Notes",
    description: "Convierte notas o transcripciones de reuniones en resumen, decisiones y tareas con responsables.",
    category: "productivity",
    color: "turquesa",
    input: { label: "Pega las notas o la transcripción", placeholder: "Juan: deberíamos…" },
    instructions: instructions("Eres un secretario de actas preciso."),
    stages: [S.generate("resumen, decisiones tomadas, tareas (responsable, fecha) y temas pendientes", "(sin trabajo previo)")],
    capabilities: ["Acta", "Tareas con responsable"],
  }),
  agent({
    id: "email-assistant",
    name: "Email Assistant",
    description: "Redacta o mejora correos profesionales con el tono adecuado.",
    category: "productivity",
    color: "rosa",
    input: { label: "¿Qué correo necesitas?", placeholder: "Pedir a un cliente que pague una factura atrasada, tono amable" },
    instructions: instructions("Eres experto en comunicación profesional escrita."),
    stages: [S.generate("el correo (asunto + cuerpo) y una versión alternativa más breve", "(sin trabajo previo)")],
    capabilities: ["Tono", "Asunto", "Alternativas"],
  }),
];
