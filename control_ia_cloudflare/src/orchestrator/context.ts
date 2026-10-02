// Contexto del proyecto para el orquestador: objetivo, instrucciones, memoria
// fijada y extracto de los archivos marcados «incluir en contexto».
// Se valida el dueño: nunca se mezcla contexto de otros usuarios.

import { all, one } from "../db";

export interface ProjectContext {
  id: number;
  name: string;
  /** Objetivo + instrucciones + memoria (compacto, para todos los agentes). */
  text: string;
  /** Extracto de archivos de texto incluidos en contexto (solo para agentes que analizan/producen). */
  files: string;
}

const MAX_TEXT = 3000;
const MAX_FILES = 4000;
const KIND_LABEL: Record<string, string> = { objective: "Objetivo", instruction: "Instrucción", preference: "Preferencia", decision: "Decisión", fact: "Dato" };

export async function projectContext(db: D1Database, projectId: number, userId: number): Promise<ProjectContext | null> {
  const p = await one<any>(db, "SELECT id, name, description, objective, instructions FROM projects WHERE id = ? AND owner_id = ?", projectId, userId);
  if (!p) return null;
  const memory = await all<any>(db, "SELECT kind, content FROM project_memory WHERE project_id = ? AND pinned = 1 ORDER BY id LIMIT 40", projectId);
  const lines: string[] = [];
  if (p.objective || p.description) lines.push(`Objetivo: ${p.objective || p.description}`);
  if (p.instructions) lines.push(`Instrucciones: ${String(p.instructions).slice(0, 1200)}`);
  for (const m of memory) lines.push(`${KIND_LABEL[m.kind] ?? "Nota"}: ${m.content}`);
  let text = lines.join("\n");
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}…`;
  const files = await all<any>(
    db,
    "SELECT name, content FROM project_files WHERE project_id = ? AND include_in_context = 1 AND mime LIKE 'text/%' ORDER BY id LIMIT 6",
    projectId,
  );
  let budget = MAX_FILES;
  const parts: string[] = [];
  for (const f of files) {
    if (budget <= 200) break;
    const chunk = String(f.content).slice(0, Math.min(1500, budget));
    budget -= chunk.length;
    parts.push(`<contenido_externo origen="archivo:${f.name}">\n${chunk}\n</contenido_externo>`);
  }
  return { id: p.id, name: p.name, text: text || "(sin objetivo ni memoria todavía)", files: parts.join("\n") };
}
