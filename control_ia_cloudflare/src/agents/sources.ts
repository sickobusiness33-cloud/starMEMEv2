// Frameworks y proyectos open source analizados para el Agent Hub.
//
// Licencias verificadas el 2026-09-28 leyendo el archivo LICENSE de cada
// repositorio (raw.githubusercontent.com). NO se ha copiado código de ninguno:
//   - "method":    su metodología (idea, patrón de roles/etapas) inspira un agente
//                  propio; las ideas no están protegidas por licencia, pero se
//                  atribuye igualmente.
//   - "reference": solo se enlaza (no se ejecuta en Cloudflare o la licencia
//                  tiene restricciones).
//   - "excluded":  licencia incompatible con uso comercial o no verificable → solo enlace informativo.

export interface FrameworkSource {
  repo: string;
  name: string;
  license: string;
  status: "compatible" | "restricted" | "incompatible" | "unverifiable";
  integration: "method" | "reference" | "excluded";
  language: string;
  cloudflare: "no" | "parcial" | "sí";
  notes: string;
}

export const VERIFIED_AT = "2026-09-28";

export const FRAMEWORKS: FrameworkSource[] = [
  // --- Compatibles (MIT / Apache-2.0) usados como metodología de agentes propios ---
  { repo: "stanford-oval/storm", name: "STORM", license: "MIT", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Investigación con perspectivas y esquema → base del agente Deep Research." },
  { repo: "assafelovic/gpt-researcher", name: "GPT Researcher", license: "Apache-2.0", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Patrón planificador → ejecutores → informe; inspira Research Agent." },
  { repo: "TauricResearch/TradingAgents", name: "TradingAgents", license: "Apache-2.0", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Equipo analista/alcista/bajista/riesgo; inspira el comité de inversión (solo análisis, sin operar)." },
  { repo: "virattt/ai-hedge-fund", name: "AI Hedge Fund", license: "MIT", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Agentes con estilos de inversión; solo educativo en Control IA." },
  { repo: "AI4Finance-Foundation/FinRobot", name: "FinRobot", license: "Apache-2.0", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Análisis financiero por cadena de pensamiento; inspira Finance Analyst." },
  { repo: "geekan/MetaGPT", name: "MetaGPT", license: "MIT", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Roles PM → arquitecto → ingeniero; inspira Product Squad." },
  { repo: "OpenBMB/ChatDev", name: "ChatDev", license: "Apache-2.0", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Empresa virtual de software; inspira Code Crew." },
  { repo: "camel-ai/camel", name: "CAMEL", license: "Apache-2.0", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Role-playing entre agentes; inspira el debate de ideas." },
  { repo: "crewAIInc/crewAI", name: "CrewAI", license: "MIT", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Equipos de agentes con roles secuenciales; modelo de los flujos multiagente." },
  { repo: "microsoft/autogen", name: "AutoGen", license: "MIT (código) · CC-BY-4.0 (docs)", status: "compatible", integration: "method", language: "Python/.NET", cloudflare: "no", notes: "Conversación entre agentes; patrón revisor." },
  { repo: "langchain-ai/langgraph", name: "LangGraph", license: "MIT", status: "compatible", integration: "method", language: "Python/JS", cloudflare: "parcial", notes: "Grafos de agentes con estado; modelo del pipeline por etapas." },
  { repo: "huggingface/smolagents", name: "smolagents", license: "Apache-2.0", status: "compatible", integration: "reference", language: "Python", cloudflare: "no", notes: "Agentes que escriben código; no se ejecuta código arbitrario en Control IA." },
  { repo: "browser-use/browser-use", name: "Browser Use", license: "MIT", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Agentes de navegador; aquí se ofrece lectura de páginas sin navegador real." },
  { repo: "microsoft/magentic-ui", name: "Magentic-UI", license: "MIT", status: "compatible", integration: "reference", language: "Python", cloudflare: "no", notes: "Humano en el bucle; mismo principio que las confirmaciones de Control IA." },
  { repo: "All-Hands-AI/OpenHands", name: "OpenHands", license: "MIT", status: "compatible", integration: "reference", language: "Python", cloudflare: "no", notes: "Agente de desarrollo con sandbox; requiere contenedores." },
  { repo: "Aider-AI/aider", name: "Aider", license: "Apache-2.0", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Programación en pareja; inspira Code Assistant." },
  { repo: "openai/openai-agents-python", name: "OpenAI Agents SDK", license: "MIT", status: "compatible", integration: "reference", language: "Python", cloudflare: "no", notes: "Handoffs entre agentes." },
  { repo: "openai/swarm", name: "Swarm", license: "MIT", status: "compatible", integration: "method", language: "Python", cloudflare: "no", notes: "Traspaso entre agentes ligeros; inspira el enrutado por agente en el chat." },
  { repo: "pydantic/pydantic-ai", name: "PydanticAI", license: "MIT", status: "compatible", integration: "reference", language: "Python", cloudflare: "no", notes: "Agentes con salida tipada." },
  { repo: "microsoft/semantic-kernel", name: "Semantic Kernel", license: "MIT", status: "compatible", integration: "reference", language: "C#/Python/Java", cloudflare: "no", notes: "Orquestación de plugins." },
  { repo: "run-llama/llama_index", name: "LlamaIndex", license: "MIT", status: "compatible", integration: "reference", language: "Python/TS", cloudflare: "parcial", notes: "RAG; candidato para búsqueda sobre archivos (Vectorize)." },
  { repo: "deepset-ai/haystack", name: "Haystack", license: "Apache-2.0", status: "compatible", integration: "reference", language: "Python", cloudflare: "no", notes: "RAG y pipelines." },
  { repo: "infiniflow/ragflow", name: "RAGFlow", license: "Apache-2.0", status: "compatible", integration: "reference", language: "Python", cloudflare: "no", notes: "RAG con documentos." },
  { repo: "mem0ai/mem0", name: "Mem0", license: "Apache-2.0", status: "compatible", integration: "reference", language: "Python/TS", cloudflare: "parcial", notes: "Memoria de agentes." },
  { repo: "microsoft/TaskWeaver", name: "TaskWeaver", license: "MIT", status: "compatible", integration: "reference", language: "Python", cloudflare: "no", notes: "Análisis de datos con código." },
  { repo: "TransformerOptimus/SuperAGI", name: "SuperAGI", license: "MIT", status: "compatible", integration: "reference", language: "Python", cloudflare: "no", notes: "Agentes autónomos (no se habilitan acciones autónomas)." },
  { repo: "danny-avila/LibreChat", name: "LibreChat", license: "MIT", status: "compatible", integration: "reference", language: "TypeScript", cloudflare: "no", notes: "Interfaz de chat multimodelo." },
  { repo: "cloudflare/agents", name: "Cloudflare Agents SDK", license: "MIT", status: "compatible", integration: "reference", language: "TypeScript", cloudflare: "sí", notes: "Candidato para agentes con estado (Durable Objects) en una fase futura." },
  { repo: "vercel/ai", name: "Vercel AI SDK", license: "Apache-2.0", status: "compatible", integration: "reference", language: "TypeScript", cloudflare: "sí", notes: "SDK de IA para TS; alternativa al router propio." },
  { repo: "modelcontextprotocol/servers", name: "MCP Servers", license: "MIT → Apache-2.0 (en transición)", status: "compatible", integration: "reference", language: "TS/Python", cloudflare: "parcial", notes: "Servidores MCP de referencia; conectores futuros." },
  { repo: "modelcontextprotocol/typescript-sdk", name: "MCP TypeScript SDK", license: "MIT → Apache-2.0 (en transición)", status: "compatible", integration: "reference", language: "TypeScript", cloudflare: "sí", notes: "Base para exponer herramientas vía MCP." },
  // --- Listas usadas para descubrir fuentes (solo enlaces, sin copiar descripciones) ---
  { repo: "Shubhamsaboo/awesome-llm-apps", name: "awesome-llm-apps", license: "Apache-2.0", status: "compatible", integration: "reference", language: "Lista", cloudflare: "no", notes: "Fuente de descubrimiento." },
  { repo: "jim-schwoebel/awesome_ai_agents", name: "awesome_ai_agents", license: "Apache-2.0", status: "compatible", integration: "reference", language: "Lista", cloudflare: "no", notes: "Fuente de descubrimiento (1.489 repos)." },
  { repo: "slavakurilyak/awesome-ai-agents", name: "awesome-ai-agents (slavakurilyak)", license: "MIT", status: "compatible", integration: "reference", language: "Lista", cloudflare: "no", notes: "Fuente de descubrimiento (193 repos)." },
  { repo: "punkpeye/awesome-mcp-servers", name: "awesome-mcp-servers", license: "MIT", status: "compatible", integration: "reference", language: "Lista", cloudflare: "no", notes: "Fuente de descubrimiento (4.054 repos)." },
  // --- Restringidos o excluidos: solo se enlazan ---
  { repo: "Significant-Gravitas/AutoGPT", name: "AutoGPT", license: "MIT (classic) + PolyForm Shield (plataforma)", status: "incompatible", integration: "excluded", language: "Python/TS", cloudflare: "no", notes: "La plataforma usa PolyForm Shield: no se incorpora." },
  { repo: "langgenius/dify", name: "Dify", license: "Apache-2.0 con condiciones adicionales", status: "restricted", integration: "excluded", language: "Python/TS", cloudflare: "no", notes: "Condiciones de marca y multi-tenant: no se incorpora." },
  { repo: "n8n-io/n8n", name: "n8n", license: "Sustainable Use License", status: "incompatible", integration: "excluded", language: "TypeScript", cloudflare: "no", notes: "No permite ofrecerlo como servicio comercial." },
  { repo: "open-webui/open-webui", name: "Open WebUI", license: "BSD-3 + cláusula de marca", status: "restricted", integration: "excluded", language: "Python/Svelte", cloudflare: "no", notes: "Exige conservar su marca: no se incorpora." },
  { repo: "lobehub/lobe-chat", name: "LobeChat", license: "LobeHub Community License", status: "restricted", integration: "excluded", language: "TypeScript", cloudflare: "no", notes: "Licencia propia con condiciones comerciales." },
  { repo: "FlowiseAI/Flowise", name: "Flowise", license: "Apache-2.0 + partes Enterprise", status: "restricted", integration: "excluded", language: "TypeScript", cloudflare: "no", notes: "Contiene código Enterprise con otra licencia." },
  { repo: "mastra-ai/mastra", name: "Mastra", license: "Apache-2.0 + partes Enterprise", status: "restricted", integration: "excluded", language: "TypeScript", cloudflare: "parcial", notes: "Contiene código Enterprise con otra licencia." },
  { repo: "reworkd/AgentGPT", name: "AgentGPT", license: "GPL-3.0", status: "restricted", integration: "excluded", language: "TypeScript", cloudflare: "no", notes: "Copyleft: no se incorpora." },
  { repo: "khoj-ai/khoj", name: "Khoj", license: "AGPL-3.0", status: "restricted", integration: "excluded", language: "Python", cloudflare: "no", notes: "AGPL: no se incorpora." },
  { repo: "Skyvern-AI/skyvern", name: "Skyvern", license: "AGPL-3.0", status: "restricted", integration: "excluded", language: "Python", cloudflare: "no", notes: "AGPL: no se incorpora." },
  { repo: "e2b-dev/awesome-ai-agents", name: "awesome-ai-agents (e2b)", license: "CC BY-NC-SA 4.0", status: "incompatible", integration: "excluded", language: "Lista", cloudflare: "no", notes: "No comercial: no se usó ni su contenido." },
  { repo: "kyrolabs/awesome-agents", name: "awesome-agents (kyrolabs)", license: "No verificable", status: "unverifiable", integration: "excluded", language: "Lista", cloudflare: "no", notes: "Sin archivo de licencia: no se usó." },
  { repo: "yoheinakajima/babyagi", name: "BabyAGI", license: "MIT declarada, archivo no encontrado", status: "unverifiable", integration: "excluded", language: "Python", cloudflare: "no", notes: "Licencia no verificable en la rama principal." },
  { repo: "HKUDS/AI-Trader", name: "AI-Trader", license: "MIT declarada, archivo no encontrado", status: "unverifiable", integration: "excluded", language: "Python", cloudflare: "no", notes: "Licencia no verificable en la rama principal." },
  { repo: "anthropics/skills", name: "Anthropic Skills", license: "Mixta (Apache-2.0 + source-available)", status: "restricted", integration: "excluded", language: "Markdown/Python", cloudflare: "no", notes: "Las skills de documentos no son open source: no se incorpora." },
];

/** Modelos que usa la plataforma y sus licencias (atribución obligatoria donde aplica). */
export const MODELS = [
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B (Meta)", license: "Llama 3.3 Community License", use: "Modelo gratuito principal", attribution: "Built with Llama" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fp8", name: "Llama 3.1 8B (Meta)", license: "Llama 3.1 Community License", use: "Respaldo gratuito", attribution: "Built with Llama" },
  { id: "@cf/black-forest-labs/flux-1-schnell", name: "FLUX.1 [schnell]", license: "Apache-2.0", use: "Generación de imágenes", attribution: "Black Forest Labs" },
  { id: "claude", name: "Claude (Anthropic)", license: "Servicio comercial (API)", use: "Premium cuando haya créditos o clave propia", attribution: "Anthropic" },
];
