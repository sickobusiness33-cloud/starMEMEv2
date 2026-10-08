// Herramientas REALES del Autopilot. Cada una valida sus argumentos, tiene un riesgo fijo
// (policy.ts) y devuelve texto. Lo que viene de fuera (código, web, issues) se envuelve como
// dato no fiable para que un agente no obedezca instrucciones escondidas (prompt injection).

import { instantiate } from "../connectors";
import type { GitHubConnector } from "../connectors/github";
import { all, nowIso, run } from "../db";
import type { Env } from "../env";
import { linkedConnector, untrusted, webRead } from "../tools";
import { forbiddenPath, looksLikeSecret, type ApToolId } from "./policy";

export class ApToolError extends Error {}

export interface ApToolCtx {
  env: Env;
  userId: number;
  goalId: number;
  taskId: number;
  projectId: number | null;
}

const str = (v: unknown, name: string, max: number, min = 1): string => {
  if (typeof v !== "string" || v.trim().length < min) throw new ApToolError(`Falta el argumento «${name}».`);
  if (v.length > max) throw new ApToolError(`«${name}» es demasiado largo (máx. ${max}).`);
  return v.trim();
};
const safePath = (p: string) => {
  const path = p.replace(/^\/+/, "");
  if (path.includes("..") || /[\0\\]/.test(path)) throw new ApToolError("Ruta no válida.");
  return path;
};

async function github(ctx: ApToolCtx): Promise<GitHubConnector> {
  if (!ctx.projectId) throw new ApToolError("Este objetivo no está vinculado a un proyecto con conector de GitHub.");
  const row = await linkedConnector(ctx.env, ctx.projectId, "github");
  if (!row) throw new ApToolError("El proyecto no tiene un conector de GitHub activo y verificado.");
  const c = (await instantiate(ctx.env, row)) as unknown as GitHubConnector;
  await run(ctx.env.DB, "UPDATE connectors SET last_used_at = ? WHERE id = ?", nowIso(), row.id);
  return c;
}

export const TOOL_HELP: Record<ApToolId, string> = {
  "repo.list_files": '{"prefix": "src/"} — lista archivos del repositorio',
  "repo.read_file": '{"path": "src/index.ts"} — lee un archivo',
  "repo.list_issues": "{} — issues abiertas",
  "repo.ci_status": '{"ref": "rama-o-commit"} — resultado real de los tests (GitHub Actions)',
  "repo.create_issue": '{"title": "...", "body": "..."} — abre una issue (riesgo MEDIO)',
  "repo.propose_pr": '{"title": "...", "description": "...", "files": [{"path": "ruta", "content": "archivo COMPLETO"}]} — abre un Pull Request (riesgo ALTO: necesita aprobación)',
  "web.read": '{"url": "https://..."} — lee una página pública',
  "memory.write": '{"kind": "knowledge|decision|solution", "content": "..."} — guarda algo útil para el futuro',
  "system.health": "{} — errores recientes, cupos y fallos de proveedores de la plataforma",
};

export async function runTool(ctx: ApToolCtx, tool: ApToolId, a: Record<string, any>): Promise<string> {
  switch (tool) {
    case "repo.list_files": {
      const gh = await github(ctx);
      return untrusted("repo:tree", await gh.listFiles(typeof a.prefix === "string" ? safePath(a.prefix).slice(0, 200) : "", 250));
    }
    case "repo.read_file": {
      const path = safePath(str(a.path, "path", 300));
      const gh = await github(ctx);
      return untrusted(`repo:${path}`, (await gh.readFile(path)).slice(0, 24_000));
    }
    case "repo.list_issues": {
      const gh = await github(ctx);
      return untrusted("repo:issues", JSON.stringify(await gh.listIssues("open", 15)));
    }
    case "repo.ci_status": {
      const ref = str(a.ref, "ref", 120);
      if (!/^[A-Za-z0-9._\/-]+$/.test(ref)) throw new ApToolError("Referencia no válida.");
      const gh = await github(ctx);
      return untrusted(`repo:ci:${ref}`, JSON.stringify(await gh.ciStatus(ref)));
    }
    case "repo.create_issue": {
      const title = str(a.title, "title", 200, 5), body = str(a.body, "body", 8000, 10);
      if (looksLikeSecret(title + body)) throw new ApToolError("El texto parece contener un secreto: bloqueado.");
      const gh = await github(ctx);
      return gh.createIssue(`[Kairo Autopilot] ${title}`, `${body}\n\n---\n_Creado por Kairo Autopilot (tarea #${ctx.taskId})._`);
    }
    case "repo.propose_pr": {
      const title = str(a.title, "title", 200, 5), description = str(a.description, "description", 8000, 10);
      if (!Array.isArray(a.files) || !a.files.length || a.files.length > 8) throw new ApToolError("Hacen falta entre 1 y 8 archivos.");
      const files = a.files.map((f: any) => {
        const path = safePath(str(f?.path, "files.path", 300));
        const content = typeof f?.content === "string" ? f.content : "";
        if (!content.trim() || content.length > 120_000) throw new ApToolError(`Contenido vacío o demasiado grande en ${path}.`);
        if (forbiddenPath(path)) throw new ApToolError(`${path} está protegido (CI, secretos o despliegue): no se puede tocar.`);
        if (looksLikeSecret(content)) throw new ApToolError(`${path} parece contener un secreto: bloqueado.`);
        return { ruta: path, contenido: content };
      });
      const gh = await github(ctx);
      return gh.proposeChanges(`[Autopilot] ${title}`, `${description}\n\nTarea #${ctx.taskId} de Kairo Autopilot.`, files);
    }
    case "web.read":
      return webRead({ env: ctx.env } as any, { url: str(a.url, "url", 2000) });
    case "memory.write": {
      const kind = ["knowledge", "decision", "solution"].includes(a.kind) ? a.kind : "knowledge";
      const content = str(a.content, "content", 2000, 10);
      await run(ctx.env.DB, "INSERT INTO ap_memory (user_id, goal_id, kind, content, source_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", ctx.userId, ctx.goalId, kind, content, ctx.taskId, nowIso());
      return "Guardado en memoria.";
    }
    case "system.health": {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const errors = await all<any>(ctx.env.DB, "SELECT provider, model, error, COUNT(*) AS n FROM usage_events WHERE ok = 0 AND created_at >= ? GROUP BY provider, model, error ORDER BY n DESC LIMIT 10", since);
      const health = await all<any>(ctx.env.DB, "SELECT provider, available_after, last_error FROM provider_health WHERE available_after IS NOT NULL");
      const failed = await all<any>(ctx.env.DB, "SELECT status, COUNT(*) AS n FROM chat_runs WHERE created_at >= ? GROUP BY status", since);
      return untrusted("sistema", JSON.stringify({ errores_24h: errors, proveedores_en_pausa: health, ejecuciones_24h: failed }));
    }
  }
}
