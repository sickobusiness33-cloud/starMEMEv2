// Construye manifiestos a partir de entradas compactas [id, nombre, categoría, sector].
// Descripción, instrucciones y etapas son plantillas propias de Kairo (no se copia texto externo).

import type { AgentManifest, CategoryId } from "../types";
import { instructions } from "./_helpers";

export type DirEntry = [string, string, string, string];

const SECTOR_ES: Record<string, string> = {
  "Aerospace & Defense": "aeroespacial y defensa", Agriculture: "agricultura", Automotive: "automoción", Biotechnology: "biotecnología",
  "Chemical Industry": "industria química", "Construction & Real Estate": "construcción e inmobiliaria", "Consumer Goods": "bienes de consumo",
  "Customer Service": "atención al cliente", Cybersecurity: "ciberseguridad", "Daily Life & Convenience": "vida diaria",
  "Digital Marketing": "marketing digital", "E-commerce": "comercio electrónico", Education: "educación", Energy: "energía",
  Enterprise: "empresa", "Entertainment & Leisure": "ocio y entretenimiento", "Environmental Services": "servicios medioambientales",
  "Fashion & Apparel": "moda", "Finance & Accounting": "finanzas y contabilidad", Financial: "finanzas personales",
  "Financial Services": "servicios financieros", "Food & Beverage": "alimentación y bebidas", "Gaming Industry": "videojuegos",
  Government: "administración pública", "Health & Wellness": "salud y bienestar", Healthcare: "sanidad", Hospitality: "hostelería y turismo",
  "Human Resources": "recursos humanos", "Information Technology": "tecnologías de la información", "Insurance Industry": "seguros",
  Legal: "legal", Manufacturing: "fabricación", "Media & Entertainment": "medios y entretenimiento", "Mining & Resources": "minería y recursos",
  Miscellaneous: "uso personal", Motorsport: "motor (F1, MotoGP)", Multisector: "varios sectores", "Non-Profit": "ONG y tercer sector",
  "Office & Administration": "oficina y administración", Personal: "uso personal", Pharmaceutical: "farmacéutica",
  "Productivity & Learning": "productividad y aprendizaje", Professional: "trabajo profesional", "Professional Services": "servicios profesionales",
  "Public Transportation": "transporte público", "Real Estate": "inmobiliaria", "Research & Development": "I+D", Retail: "comercio minorista",
  "Sales & Marketing": "ventas y marketing", "Security & Privacy": "seguridad y privacidad", "Smart Cities": "ciudades inteligentes",
  "Social & Communication": "relaciones y comunicación", "Sports & Recreation": "deporte", "Technology Sector": "tecnología",
  Telecommunications: "telecomunicaciones", "Transportation & Logistics": "transporte y logística", Utilities: "suministros (agua, luz, gas)",
};

// Reglas propias por categoría: cómo trabaja y qué límites respeta.
const GUIDE: Record<string, { cap: "chat" | "code" | "reasoning"; how: string; limits?: string; color: AgentManifest["color"] }> = {
  personal: { cap: "chat", color: "rosa", how: "Haz 1-2 preguntas si faltan datos personales clave; después entrega un plan práctico, paso a paso, adaptado a la persona." },
  health: { cap: "reasoning", color: "verde", how: "Da información general basada en evidencia, hábitos y señales de alarma.", limits: "No diagnosticas ni recetas: ante síntomas serios o urgencias, recomienda acudir a un profesional sanitario o al 112." },
  finance: { cap: "reasoning", color: "verde", how: "Trabaja con números: supuestos explícitos, tablas, escenarios y riesgos.", limits: "No es asesoramiento financiero personalizado; nunca pidas claves, contraseñas ni datos bancarios completos." },
  legal: { cap: "reasoning", color: "morado", how: "Estructura el caso, identifica normas y riesgos, y propone siguientes pasos.", limits: "No sustituyes a un abogado: indica la jurisdicción asumida y cuándo conviene consultar a un profesional." },
  public: { cap: "reasoning", color: "azul", how: "Piensa en ciudadanos, normativa, transparencia y recursos públicos; propone indicadores y procesos auditables." },
  industry: { cap: "reasoning", color: "naranja", how: "Enfócate en operaciones: procesos, KPIs, costes, seguridad laboral y datos necesarios para decidir." },
  education: { cap: "chat", color: "turquesa", how: "Adapta el nivel al alumno, usa ejemplos y ejercicios, y comprueba la comprensión." },
  sports: { cap: "reasoning", color: "naranja", how: "Usa datos, estadísticas y escenarios; separa hechos comprobados de estimaciones." },
  coding: { cap: "code", color: "azul", how: "Entrega soluciones técnicas concretas (código, arquitectura, comandos) y explica riesgos y pruebas." },
  security: { cap: "reasoning", color: "morado", how: "Evalúa amenazas, riesgos y controles con enfoque defensivo.", limits: "Solo ayudas en seguridad defensiva y autorizada." },
};
const DEFAULT = { cap: "chat" as const, color: "azul" as const, how: "Entrega un resultado concreto: diagnóstico breve, plan de acción y entregable listo para usar." };

export function buildDirectoryAgents(entries: DirEntry[]): AgentManifest[] {
  return entries.map(([id, name, category, sector]) => {
    const g = GUIDE[category] ?? DEFAULT;
    const area = SECTOR_ES[sector] ?? sector;
    return {
      id,
      name,
      description: `Agente «${name}» para ${area}: analiza tu caso y te entrega un plan y un resultado concreto y accionable.`,
      category: category as CategoryId,
      version: "1.0.0",
      tier: "free",
      color: g.color,
      model: { prefer: "free", allowFallback: true, capability: g.cap },
      input: { label: "Tu petición", placeholder: `Cuéntale a ${name} qué necesitas…` },
      instructions: instructions(
        `Eres «${name}», un agente de IA especializado en esa tarea dentro del ámbito de ${area}. Tu trabajo es exactamente lo que indica tu nombre: ` +
          "entiende el objetivo del usuario, detecta los datos que faltan y resuelve con criterio de experto.",
        [g.how, g.limits, "Formato: 1) Resumen en una frase. 2) Análisis o supuestos. 3) Plan o entregable. 4) Siguientes pasos."].filter(Boolean).join("\n"),
      ),
      stages: [{ id: "generating", label: "Generating", kind: "llm", prompt: `Petición del usuario:\n{{input}}\n\nResuélvela como ${name} (${area}): entrega un resultado concreto, estructurado y accionable.` }],
      tools: [],
      capabilities: [name, area].slice(0, 2),
      source: {
        type: "original",
        label: "Control IA",
        license: "Original (Control IA)",
        attribution: "Nombre del agente tomado de la lista pública «agent-directory»; descripción e instrucciones propias de Control IA.",
      },
      added: "2026-09-30",
    };
  });
}
