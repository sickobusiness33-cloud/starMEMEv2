// Registro de auditoría (quién, qué, cuándo, resultado). Todo pasa por redact().

import { redact } from "./crypto";
import { all, nowIso, run } from "./db";
import type { User } from "./env";

export async function record(
  db: D1Database,
  e: {
    actor: string;
    action: string;
    result?: string;
    userId?: number | null;
    projectId?: number | null;
    target?: string | null;
    detail?: string | null;
  },
) {
  await run(
    db,
    "INSERT INTO audit_log (ts, user_id, actor, project_id, action, target, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    nowIso(),
    e.userId ?? null,
    redact(e.actor).slice(0, 200),
    e.projectId ?? null,
    e.action,
    e.target ? redact(e.target).slice(0, 300) : null,
    e.result ?? "ok",
    e.detail ? redact(e.detail).slice(0, 2000) : null,
  );
}

export async function listEntries(db: D1Database, user: User, q: string, result: string, projectId?: number) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (user.role !== "admin") {
    where.push("(a.user_id = ? OR a.project_id IN (SELECT id FROM projects WHERE owner_id = ?))");
    params.push(user.id, user.id);
  }
  if (projectId) {
    where.push("a.project_id = ?");
    params.push(projectId);
  }
  if (q) {
    where.push("(a.action LIKE ? OR a.target LIKE ? OR a.detail LIKE ? OR a.actor LIKE ?)");
    params.push(...Array(4).fill(`%${q}%`));
  }
  if (result) {
    where.push("a.result = ?");
    params.push(result);
  }
  let sql = "SELECT a.*, p.name AS project_name FROM audit_log a LEFT JOIN projects p ON p.id = a.project_id";
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY a.id DESC LIMIT 200";
  return all(db, sql, ...params);
}
