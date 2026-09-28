// AI ORCHESTRATOR · planificador.
//
// Todos los agentes del registro están disponibles en cada chat. El
// planificador decide cuáles usar (0 = responde Kairo directamente), cuántos,
// en qué orden y con qué dependencias. Primero lo intenta un modelo (JSON
// validado); si no devuelve un plan válido se usa un planificador por reglas.

import { generate, type CallContext } from "../ai/router";
import type { RegistryAgent } from "../agents/registry";
import type { PlanId } from "../plans";

export interface PlanStep {
  id: string;
  agent: string;
  task: string;
  depends_on: string[];
}

export interface Plan {
  direct: boolean;
  steps: PlanStep[];
  reason: string;
  planner: "llm" | "rules" | "manual";
}

export interface PoolAgent extends RegistryAgent {
  locked: boolean;
}

/** Agentes utilizables por el orquestador: todos menos los flujos multiagente (ya lo es él). */
export function orchestratorPool(agents: RegistryAgent[], plan: PlanId): PoolAgent[] {
  return agents
    .filter((a) => a.category !== "multi" && !a.stages.some((s) => s.kind === "agents"))
    .map((a) => ({ ...a, locked: a.tier === "pro" && plan !== "pro" }));
}

/** 0 = análisis/investigación · 1 = producción de contenido · 2 = medios (imagen). */
export function stageClass(a: RegistryAgent): number {
  const tools = a.stages.filter((s) => s.kind === "tool").map((s) => (s as any).tool as string);
  if (tools.some((t) => ["image_generate", "image_edit", "image_variation", "image_upscale"].includes(t))) return 2;
  if (tools.includes("vision_describe") || tools.includes("wikipedia_search") || tools.includes("web_read")) return 0;
  if (["research", "data", "trading", "finance", "security", "browser"].includes(a.category)) return 0;
  return 1;
}

/** Encadena por clases: cada clase depende de todos los pasos de la clase anterior no vacía. */
export function chainByClass(steps: PlanStep[], byId: Map<string, RegistryAgent>): PlanStep[] {
  const cls = (s: PlanStep) => stageClass(byId.get(s.agent)!);
  const classes = [...new Set(steps.map(cls))].sort();
  return steps.map((s) => {
    const idx = classes.indexOf(cls(s));
    const prev = idx > 0 ? steps.filter((x) => cls(x) === classes[idx - 1]).map((x) => x.id) : [];
    return { ...s, depends_on: prev };
  });
}

/** Valida un plan (ids, agentes accesibles, sin ciclos, dependencias hacia atrás). */
export function validatePlan(raw: any, pool: Map<string, PoolAgent>, max: number, hasImages: boolean): Plan | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.direct === true && (!Array.isArray(raw.steps) || !raw.steps.length)) {
    return { direct: true, steps: [], reason: String(raw.reason ?? "Respuesta directa").slice(0, 200), planner: "llm" };
  }
  if (!Array.isArray(raw.steps) || !raw.steps.length) return null;
  const steps: PlanStep[] = [];
  const seenAgents = new Set<string>();
  const rawToId = new Map<string, string>(); // ids del modelo → ids validados (solo pasos anteriores: sin ciclos)
  for (const s of raw.steps) {
    if (steps.length >= max) break;
    const a = pool.get(String(s?.agent ?? ""));
    if (!a || a.locked || seenAgents.has(a.id)) continue;
    if (a.input.image === "required" && !hasImages) continue;
    const id = `s${steps.length + 1}`;
    const deps = (Array.isArray(s.depends_on) ? s.depends_on : []).map((d: unknown) => rawToId.get(String(d))).filter(Boolean) as string[];
    rawToId.set(String(s.id ?? id), id);
    steps.push({ id, agent: a.id, task: String(s.task ?? "").slice(0, 400) || `Aporta tu parte como ${a.name}.`, depends_on: [...new Set(deps)] });
    seenAgents.add(a.id);
  }
  if (!steps.length) return null;
  return { direct: false, steps, reason: String(raw.reason ?? "").slice(0, 300), planner: "llm" };
}

// --- planificador por reglas (respaldo sin modelo) -------------------------------------------

const RULES: [RegExp, string[]][] = [
  [/\b(upscal|amplía|ampliar|más resolución|mayor resolución|más nitidez|\b4k\b|\bhd\b)/i, ["image-upscaler"]],
  [/\b(variaci[oó]n|variaciones|variante|otra versión)/i, ["image-variations"]],
  [/\b(edita|editar|modifica|cambia (el|la|los|las)? ?(fondo|estilo|color)|conviert[ea]la|retoca)/i, ["image-editor"]],
  [/\b(logo|logotipo|isotipo)/i, ["logo-concepts"]],
  [/\b(post|publicaci[oó]n|instagram|tiktok|linkedin|tweet|twitter|\bx\.com|redes sociales|publicarla|publicarlo)/i, ["social-post-creator"]],
  [/\b(imagen|image|ilustraci[oó]n|dibuja|dibujo|p[oó]ster|poster|foto de|picture|wallpaper|portada|render)/i, ["image-generator"]],
  [/\b(traduce|traducir|translate|traducción)/i, ["translator"]],
  [/\b(resume|resumen|resumir|summar|tl;?dr)/i, ["summarizer"]],
  [/\b(sql|consulta a la base|query)/i, ["sql-helper"]],
  [/\b(regex|expresi[oó]n regular)/i, ["regex-builder"]],
  [/\b(revisa (mi|este) c[oó]digo|code review|revisi[oó]n de c[oó]digo)/i, ["code-reviewer"]],
  [/\b(c[oó]digo|code|funci[oó]n|bug|javascript|typescript|python|script|programa|api rest|endpoint|html|css)/i, ["code-assistant"]],
  [/\b(calcula|ecuaci[oó]n|matem[aá]tic|resuelve|probabilidad|porcentaje|inter[eé]s compuesto)/i, ["math-solver"]],
  [/\b(verifica|es cierto|es verdad|fact.?check|bulo|desmiente)/i, ["fact-checker"]],
  [/\b(investiga|investigaci[oó]n|research|historia de|qu[eé] es|qui[eé]n (es|fue)|expl[ií]came|fuentes)/i, ["research-agent"]],
  [/\b(riesgo|riesgos|risk)/i, ["risk-reviewer"]],
  [/\b(datos|csv|tabla|kpi|estad[ií]stica|m[eé]tricas)/i, ["data-analyst"]],
  [/\b(marketing|campaña|anuncio|\bads?\b|publicidad|copy)/i, ["marketing-strategist"]],
  [/\b(dafo|swot|foda)/i, ["swot"]],
  [/\b(plan de negocio|business plan|startup|modelo de negocio)/i, ["business-plan"]],
  [/\b(v[ií]deo|video|guion|youtube|reels|shorts)/i, ["video-script"]],
  [/\b(email|correo|mail)/i, ["email-assistant"]],
  [/\b(art[ií]culo|blog|redacta|escribe un texto)/i, ["blog-writer"]],
  [/\b(cuento|relato|historia corta|poema)/i, ["storyteller"]],
  [/\b(phishing|contraseña|vulnerab|seguridad)/i, ["phishing-detector"]],
  [/\b(organiza|planifica|tareas|to-?do|agenda|pasos para)/i, ["task-planner"]],
  [/\b(seo|posicionamiento)/i, ["seo-auditor"]],
];

export function planWithRules(request: string, pool: Map<string, PoolAgent>, max: number, hasImages: boolean): Plan {
  const picked: string[] = [];
  const add = (id: string) => {
    const a = pool.get(id);
    if (a && !a.locked && !picked.includes(id) && (a.input.image !== "required" || hasImages)) picked.push(id);
  };
  const hasUrl = /https?:\/\/\S+/.test(request);
  if (hasImages) {
    // Con imagen adjunta: editarla/ampliarla/variarla si se pide; si no, analizarla.
    if (/\b(upscal|amplía|ampliar|resoluci[oó]n|nitidez|4k|hd)/i.test(request)) add("image-upscaler");
    else if (/\b(variaci[oó]n|variante|otra versión)/i.test(request)) add("image-variations");
    else if (/\b(edita|modifica|cambia|convi[eé]rte|retoca|estilo|transforma)/i.test(request)) add("image-editor");
    else add("vision-analyst");
  }
  if (hasUrl) add(/\b(resume|resumen)/i.test(request) ? "summarizer" : "page-reader");
  for (const [re, ids] of RULES) if (re.test(request)) ids.forEach(add);
  // Imagen para un post: el post ya genera su imagen, no hace falta otro generador.
  if (picked.includes("social-post-creator") && picked.includes("image-generator")) picked.splice(picked.indexOf("image-generator"), 1);
  const byId = new Map([...pool].map(([k, v]) => [k, v as RegistryAgent]));
  // Orden natural del flujo: análisis → producción → medios.
  const chosen = picked.slice(0, max).sort((x, y) => stageClass(byId.get(x)!) - stageClass(byId.get(y)!));
  const words = request.trim().split(/\s+/).length;
  if (!chosen.length) {
    return { direct: true, steps: [], reason: words <= 6 ? "Mensaje breve: responde Kairo directamente." : "Ningún agente especializado encaja: responde Kairo.", planner: "rules" };
  }
  const steps = chainByClass(
    chosen.map((agent, i) => ({ id: `s${i + 1}`, agent, task: `Resuelve la parte de la petición que corresponde a ${pool.get(agent)!.name}.`, depends_on: [] })),
    byId,
  );
  return { direct: false, steps, reason: "Selección por palabras clave y capacidades de cada agente.", planner: "rules" };
}

// --- planificador con modelo ------------------------------------------------------------------

export async function planWithLLM(ctx: CallContext, request: string, history: string, pool: Map<string, PoolAgent>, max: number, hasImages: boolean): Promise<Plan | null> {
  const catalog = [...pool.values()]
    .filter((a) => !a.locked && (a.input.image !== "required" || hasImages))
    .map((a) => `${a.id} — ${a.name}: ${a.description}${a.tools.length ? ` [${a.tools.join(", ")}]` : ""}`)
    .join("\n");
  const system =
    "[planner] Eres el orquestador de Kairo. Decides qué agentes especializados deben trabajar en la petición del usuario. " +
    "Responde SOLO con JSON válido, sin texto adicional.";
  const prompt =
    `Agentes disponibles (id — nombre: descripción [herramientas]):\n${catalog}\n\n` +
    (history ? `Contexto reciente del chat:\n${history}\n\n` : "") +
    `${hasImages ? "El usuario ha adjuntado imagen(es).\n" : ""}Petición del usuario:\n${request}\n\n` +
    `Reglas:\n- Usa el MENOR número de agentes que resuelva bien la petición (máximo ${max}). No uses agentes que no aporten.\n` +
    `- Saludos, charla o preguntas simples: {"direct": true, "steps": [], "reason": "..."}.\n` +
    `- Pasos independientes sin depends_on (se ejecutan en paralelo). Si un agente necesita el resultado de otro, pon su id en depends_on.\n` +
    `- task = instrucción concreta para ese agente.\n` +
    `Formato: {"direct": false, "reason": "por qué", "steps": [{"id": "s1", "agent": "<id>", "task": "...", "depends_on": []}]}`;
  try {
    const res = await generate(ctx, { system, messages: [{ role: "user", content: prompt }], maxTokens: 500, prefer: "free", allowFallback: true, capability: "chat" });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return validatePlan(JSON.parse(m[0]), pool, max, hasImages);
  } catch {
    return null;
  }
}
