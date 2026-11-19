// Agentes de redes sociales.
import { agent, instructions, S } from "./_helpers";

export default [
  agent({
    id: "social-calendar",
    name: "Social Media Planner",
    description: "Calendario de publicaciones para 2 semanas con textos, formatos y hashtags.",
    category: "social",
    color: "rosa",
    input: { label: "Marca, red social y objetivo", placeholder: "Cafetería de barrio, Instagram, más visitas los martes" },
    instructions: instructions("Eres community manager."),
    stages: [S.plan("el calendario"), S.generate("una tabla de 14 días: día, formato, texto completo, hashtags y hora sugerida")],
    capabilities: ["Calendario", "Textos listos"],
  }),
  agent({
    id: "thread-writer",
    name: "Thread Writer",
    description: "Convierte una idea o artículo en un hilo para X/Threads con gancho y cierre.",
    category: "social",
    color: "azul",
    input: { label: "Idea o texto base", placeholder: "Pega un artículo o describe la idea" },
    instructions: instructions("Escribes hilos virales pero honestos, sin clickbait engañoso."),
    stages: [S.generate("un hilo de 6-10 publicaciones numeradas (máx. 280 caracteres cada una) con gancho inicial y llamada a la acción", "(sin trabajo previo)")],
    capabilities: ["Gancho", "Formato por publicación"],
  }),
  agent({
    id: "reply-assistant",
    name: "Community Reply Assistant",
    description: "Propone respuestas a comentarios o reseñas con el tono de tu marca.",
    category: "social",
    color: "verde",
    input: { label: "Comentario o reseña y tono de marca", placeholder: "Reseña: 'tardaron mucho'… tono: cercano" },
    instructions: instructions("Respondes con empatía, sin prometer lo que la marca no puede cumplir."),
    stages: [S.generate("3 respuestas alternativas (breve, estándar y detallada) y una recomendación de cuál usar", "(sin trabajo previo)")],
    capabilities: ["Tono de marca", "Gestión de crisis"],
  }),
];
