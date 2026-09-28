// AGENT REGISTRY — fuente única de agentes disponibles.
//
//   Catálogo integrado (src/agents/catalog/*.ts, revisado en código)
//   + agentes añadidos después como manifiesto (tabla hub_agents, status 'available')
//
// Un manifiesto pasa por: LICENSE CHECK → SECURITY CHECK → DEPENDENCY CHECK →
// COMPATIBILITY CHECK (validateManifest) → REGISTRY (validated) → AVAILABLE
// (lo publica un administrador). Nunca se ejecuta código de terceros: el
// manifiesto solo contiene texto, etapas declarativas y herramientas permitidas.

import { all, loads } from "../db";
import automation from "./catalog/automation";
import browser from "./catalog/browser";
import business from "./catalog/business";
import coding from "./catalog/coding";
import data from "./catalog/data";
import finance from "./catalog/finance";
import general from "./catalog/general";
import image from "./catalog/image";
import marketing from "./catalog/marketing";
import multi from "./catalog/multi";
import productivity from "./catalog/productivity";
import research from "./catalog/research";
import security from "./catalog/security";
import social from "./catalog/social";
import trading from "./catalog/trading";
import video from "./catalog/video";
import web from "./catalog/web";
import writing from "./catalog/writing";
import { CATEGORIES, COMPATIBLE_LICENSES, TOOL_INFO, type AgentManifest } from "./types";

export const BUILTIN: AgentManifest[] = [
  ...research,
  ...trading,
  ...coding,
  ...web,
  ...marketing,
  ...social,
  ...data,
  ...finance,
  ...productivity,
  ...automation,
  ...writing,
  ...image,
  ...video,
  ...security,
  ...business,
  ...general,
  ...multi,
  ...browser,
];

const BUILTIN_MAP = new Map(BUILTIN.map((a) => [a.id, a]));

export type RegistryAgent = AgentManifest & { origin: "builtin" | "hub" };

/** Agentes publicados en D1 (status 'available'). */
async function hubAgents(db: D1Database): Promise<RegistryAgent[]> {
  const rows = await all<any>(db, "SELECT manifest_json FROM hub_agents WHERE status = 'available' ORDER BY created_at");
  const out: RegistryAgent[] = [];
  for (const r of rows) {
    const m = loads<AgentManifest | null>(r.manifest_json, null);
    // Se revalida al leer: si una regla se endurece, el agente deja de estar disponible.
    if (m && !BUILTIN_MAP.has(m.id) && validateManifest(m, new Set(BUILTIN_MAP.keys())).ok) out.push({ ...m, origin: "hub" });
  }
  return out;
}

export async function listAgents(db: D1Database): Promise<RegistryAgent[]> {
  return [...BUILTIN.map((a) => ({ ...a, origin: "builtin" as const })), ...(await hubAgents(db))];
}

export async function getAgent(db: D1Database, id: string): Promise<RegistryAgent | null> {
  const b = BUILTIN_MAP.get(id);
  if (b) return { ...b, origin: "builtin" };
  return (await hubAgents(db)).find((a) => a.id === id) ?? null;
}

export interface CheckResult {
  step: "license" | "security" | "dependencies" | "compatibility";
  ok: boolean;
  detail: string;
}

const FORBIDDEN_KEYS = /^(code|script|exec|eval|command|shell|install|dependencies|packages|requirements|url_fetch|api_key|secret|token|wallet|env)$/i;

function findForbidden(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const f = findForbidden(value[i], `${path}[${i}]`);
      if (f) return f;
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(k)) return `${path}.${k}`;
      const f = findForbidden(v, `${path}.${k}`);
      if (f) return f;
    }
  }
  return null;
}

const isStr = (v: unknown, min: number, max: number) => typeof v === "string" && v.trim().length >= min && v.length <= max;

/** Pipeline de validación de un manifiesto. `known` = ids de agentes existentes (para subagentes). */
export function validateManifest(m: any, known: Set<string>): { ok: boolean; checks: CheckResult[] } {
  const checks: CheckResult[] = [];
  const push = (step: CheckResult["step"], ok: boolean, detail: string) => checks.push({ step, ok, detail });

  // LICENSE CHECK
  const lic = m?.source?.license;
  if (!isStr(lic, 1, 80) || !COMPATIBLE_LICENSES.includes(lic)) {
    push("license", false, `Licencia «${lic ?? "sin indicar"}» no admitida. Solo: ${COMPATIBLE_LICENSES.join(", ")}.`);
  } else if (m.source.type !== "original" && !isStr(m.source.url, 8, 300)) {
    push("license", false, "Falta la URL del proyecto de origen para verificar la licencia y la atribución.");
  } else if (m.source.type !== "original" && !isStr(m.source.attribution, 10, 600)) {
    push("license", false, "Falta el texto de atribución del proyecto de origen.");
  } else push("license", true, `Licencia ${lic} compatible con uso comercial.`);

  // SECURITY CHECK
  const forbidden = findForbidden(m);
  const tools: unknown[] = Array.isArray(m?.tools) ? m.tools : [];
  const badTools = tools.filter((t) => typeof t !== "string" || !(t in TOOL_INFO));
  if (forbidden) push("security", false, `Campo no permitido en el manifiesto: ${forbidden} (los agentes no pueden incluir código, secretos ni instalaciones).`);
  else if (badTools.length) push("security", false, `Herramientas no permitidas: ${badTools.join(", ")}.`);
  else push("security", true, "Sin código ejecutable; solo herramientas de la lista permitida con permisos explícitos.");

  // DEPENDENCY CHECK: solo puede depender de agentes existentes y no multiagente (profundidad 1).
  const stages: any[] = Array.isArray(m?.stages) ? m.stages : [];
  const deps = stages.filter((s) => s?.kind === "agents").flatMap((s) => (Array.isArray(s.agents) ? s.agents : []));
  const missing = deps.filter((d: unknown) => typeof d !== "string" || !known.has(d) || d === m?.id);
  const nested = deps.filter((d: string) => BUILTIN_MAP.get(d)?.stages.some((s) => s.kind === "agents"));
  if (missing.length) push("dependencies", false, `Subagentes inexistentes: ${missing.join(", ")}.`);
  else if (nested.length) push("dependencies", false, `Un subagente no puede ser a su vez multiagente: ${nested.join(", ")}.`);
  else push("dependencies", true, deps.length ? `Depende de: ${deps.join(", ")}.` : "Sin dependencias externas.");

  // COMPATIBILITY CHECK: estructura ejecutable por el runtime.
  const problems: string[] = [];
  if (!isStr(m?.id, 3, 60) || !/^[a-z0-9][a-z0-9-]*$/.test(m.id)) problems.push("id (minúsculas, números y guiones)");
  if (!isStr(m?.name, 2, 60)) problems.push("name");
  if (!isStr(m?.description, 10, 300)) problems.push("description");
  if (!CATEGORIES.some((c) => c.id === m?.category)) problems.push("category");
  if (!isStr(m?.version, 1, 20) || !/^\d+\.\d+\.\d+$/.test(m.version)) problems.push("version (x.y.z)");
  if (!["free", "pro"].includes(m?.tier)) problems.push("tier");
  if (!["azul", "rosa", "morado", "verde", "turquesa", "naranja"].includes(m?.color)) problems.push("color");
  if (!["free", "premium"].includes(m?.model?.prefer) || typeof m?.model?.allowFallback !== "boolean") problems.push("model");
  if (!isStr(m?.input?.label, 1, 80) || !isStr(m?.input?.placeholder, 0, 200)) problems.push("input");
  if (!isStr(m?.instructions, 10, 6000)) problems.push("instructions (10–6000 caracteres)");
  if (!Array.isArray(m?.capabilities) || m.capabilities.length > 10 || m.capabilities.some((c: unknown) => !isStr(c, 1, 60))) problems.push("capabilities");
  if (!stages.length || stages.length > 6) problems.push("stages (1–6)");
  const ids = new Set<string>();
  for (const s of stages) {
    if (!isStr(s?.id, 1, 30) || !/^[a-z][a-z0-9_]*$/.test(s.id) || ids.has(s.id) || s.id === "input") {
      problems.push(`stage id «${s?.id}»`);
      continue;
    }
    if (!isStr(s?.label, 1, 40)) problems.push(`stage ${s.id}: label`);
    if (s.kind === "llm") {
      if (!isStr(s.prompt, 3, 4000)) problems.push(`stage ${s.id}: prompt`);
      if (s.maxTokens !== undefined && !(Number.isInteger(s.maxTokens) && s.maxTokens >= 50 && s.maxTokens <= 4000)) problems.push(`stage ${s.id}: maxTokens`);
    } else if (s.kind === "tool") {
      if (!(s.tool in TOOL_INFO) || !tools.includes(s.tool)) problems.push(`stage ${s.id}: herramienta no declarada en tools`);
      if (s.from !== "input" && !ids.has(s.from)) problems.push(`stage ${s.id}: from debe ser "input" o una etapa anterior`);
    } else if (s.kind === "agents") {
      if (!Array.isArray(s.agents) || !s.agents.length || s.agents.length > 4) problems.push(`stage ${s.id}: agents (1–4)`);
      if (!isStr(s.prompt, 3, 4000)) problems.push(`stage ${s.id}: prompt`);
    } else problems.push(`stage ${s.id}: kind`);
    ids.add(s.id);
  }
  if (deps.length && m?.category !== "multi") problems.push("los flujos con subagentes deben estar en la categoría multi");
  push(
    "compatibility",
    problems.length === 0,
    problems.length ? `Campos no válidos: ${problems.join("; ")}.` : "Estructura compatible con el runtime de Control IA (Cloudflare Workers).",
  );
  return { ok: checks.every((c) => c.ok), checks };
}

/** Comprobación del catálogo integrado (se usa en tests y al arrancar el hub). */
export function builtinProblems(): string[] {
  const known = new Set(BUILTIN_MAP.keys());
  const out: string[] = [];
  if (known.size !== BUILTIN.length) out.push("ids duplicados en el catálogo");
  for (const a of BUILTIN) {
    const v = validateManifest(a, known);
    if (!v.ok) out.push(`${a.id}: ${v.checks.filter((c) => !c.ok).map((c) => c.detail).join(" ")}`);
  }
  return out;
}
