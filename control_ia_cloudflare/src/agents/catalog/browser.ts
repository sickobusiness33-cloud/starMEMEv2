// Agentes de navegador: leen páginas públicas que indique el usuario (sin JavaScript
// ni navegación autónoma, sin rellenar formularios ni iniciar sesión).
import { agent, instructions, method, S } from "./_helpers";

export default [
  agent({
    id: "page-reader",
    name: "Page Reader",
    description: "Lee una o varias páginas (hasta 3 URLs) y te las resume o responde preguntas sobre ellas.",
    category: "browser",
    color: "turquesa",
    input: { label: "URLs y qué quieres saber", placeholder: "https://… ¿qué ofrece y cuánto cuesta?" },
    instructions: instructions("Eres un asistente de lectura web."),
    stages: [S.web(), S.generate("la respuesta a la pregunta del usuario basada en las páginas, citando la URL de cada dato", "{{stage.reading}}")],
    capabilities: ["Hasta 3 páginas", "Citas por URL"],
    source: method("Browser Use", "browser-use/browser-use", "MIT"),
  }),
  agent({
    id: "web-data-extractor",
    name: "Web Data Extractor",
    description: "Extrae datos estructurados (tabla/JSON) de una página: precios, contactos, listados…",
    category: "browser",
    color: "verde",
    input: { label: "URL y datos a extraer", placeholder: "https://… extrae nombre y precio de cada producto" },
    instructions: instructions("Extraes datos con precisión; si un dato no aparece, lo dejas vacío en lugar de inventarlo."),
    stages: [S.web(), S.generate("los datos en una tabla Markdown y el mismo resultado en JSON", "{{stage.reading}}")],
    capabilities: ["Tabla", "JSON"],
  }),
  agent({
    id: "page-comparator",
    name: "Page Comparator",
    description: "Compara 2 o 3 páginas (productos, ofertas, planes) y te dice cuál conviene según tu criterio.",
    category: "browser",
    color: "naranja",
    input: { label: "2-3 URLs y tu criterio", placeholder: "https://… https://… — busco el más barato con soporte en español" },
    instructions: instructions("Eres un comparador imparcial."),
    stages: [S.web(), S.generate("una tabla comparativa y una recomendación justificada según el criterio del usuario", "{{stage.reading}}")],
    capabilities: ["Comparativa", "Recomendación"],
  }),
];
