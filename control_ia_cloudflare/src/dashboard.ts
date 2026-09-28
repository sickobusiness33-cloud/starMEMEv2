// Datos del panel principal (mapa de nodos + run log + dispatch + stats).
// Todo filtrado por el usuario: cada persona solo ve su propio grafo.

import { Hono } from "hono";
import { requireUser } from "./auth";
import { all, loads, one } from "./db";
import type { AppEnv } from "./env";
import { DEFAULT_LIMITS } from "./projects";
import { availableProviderIds, PROVIDERS } from "./providers";

export const dashboardRoutes = new Hono<AppEnv>();
dashboardRoutes.use("*", requireUser);

dashboardRoutes.get("/", async (c) => {
  const u = c.get("user");
  const db = c.env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();

  const projects = await all<any>(
    db,
    `SELECT p.id, p.name, p.color, p.status, p.provider, p.model, p.limits_json, p.is_demo,
       (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id) AS runs,
       (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id AND r.created_at >= ?) AS runs_today,
       (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id AND r.status IN ('pending','running','awaiting_confirmation')) AS active,
       (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id AND r.status = 'running') AS running,
       (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id AND r.status = 'failed') AS failed,
       (SELECT COALESCE(SUM(steps), 0) FROM runs r WHERE r.project_id = p.id) AS steps,
       (SELECT COUNT(*) FROM project_files f WHERE f.project_id = p.id) AS files,
       (SELECT COUNT(*) FROM project_tools t WHERE t.project_id = p.id) AS tools,
       (SELECT GROUP_CONCAT(pc.connector_id) FROM project_connectors pc WHERE pc.project_id = p.id) AS connector_ids
     FROM projects p WHERE p.owner_id = ? ORDER BY p.updated_at DESC LIMIT 12`,
    today,
    u.id,
  );

  const connectors = await all<any>(db, "SELECT id, name, type, status, enabled, last_used_at FROM connectors WHERE owner_id = ? ORDER BY id", u.id);
  const keys = await all<any>(db, "SELECT provider, status, last_used_at FROM user_provider_keys WHERE user_id = ?", u.id);
  const settings = c.get("settings");
  const providers = availableProviderIds(settings).map((id) => {
    const k = keys.find((x) => x.provider === id);
    const p = new PROVIDERS[id](settings);
    return { id, name: p.name, is_demo: p.isDemo, connected: p.requiresKey ? Boolean(k) : true, status: k?.status ?? "unknown", last_used_at: k?.last_used_at ?? null };
  });

  const runs = await all<any>(
    db,
    `SELECT r.id, r.status, r.input, r.steps, r.created_at, r.started_at, r.finished_at, r.usage_json, r.project_id, p.name AS project_name, p.color AS project_color
     FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.owner_id = ? ORDER BY r.id DESC LIMIT 14`,
    u.id,
  );

  const hourly = await all<any>(
    db,
    `SELECT substr(r.created_at, 1, 13) AS h, COUNT(*) AS n FROM runs r JOIN projects p ON p.id = r.project_id
     WHERE p.owner_id = ? AND r.created_at >= ? GROUP BY h ORDER BY h`,
    u.id,
    since,
  );

  const totals = await one<any>(
    db,
    `SELECT COUNT(*) AS runs,
       SUM(r.status = 'completed') AS completed, SUM(r.status = 'failed') AS failed,
       SUM(r.status IN ('pending','running','awaiting_confirmation')) AS active,
       COALESCE(SUM(r.steps), 0) AS steps
     FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.owner_id = ?`,
    u.id,
  );
  const pendingActions = await one<any>(
    db,
    "SELECT COUNT(*) AS n FROM actions a JOIN projects p ON p.id = a.project_id WHERE p.owner_id = ? AND a.status = 'pending'",
    u.id,
  );
  const tokens = await all<any>(
    db,
    "SELECT r.usage_json FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.owner_id = ? AND r.created_at >= ?",
    u.id,
    today,
  );
  const tokensToday = tokens.reduce((sum, r) => {
    const us = loads<any>(r.usage_json);
    return sum + Number(us.input_tokens ?? 0) + Number(us.output_tokens ?? 0);
  }, 0);

  // Robots del Agent Hub: últimas ejecuciones de agentes del usuario (datos reales).
  const agentRuns = await all<any>(
    db,
    "SELECT id, agent_id, status, stage, stages_json, created_at, finished_at FROM agent_runs WHERE user_id = ? ORDER BY id DESC LIMIT 8",
    u.id,
  );

  return c.json({
    agent_runs: agentRuns.map((r) => ({ ...r, stages: loads(r.stages_json, []), stages_json: undefined })),
    projects: projects.map((p) => ({
      ...p,
      is_demo: Boolean(p.is_demo),
      limit_per_day: { ...DEFAULT_LIMITS, ...loads(p.limits_json) }.max_runs_per_day,
      connector_ids: String(p.connector_ids ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number),
      limits_json: undefined,
    })),
    connectors: connectors.map((x) => ({ ...x, enabled: Boolean(x.enabled) })),
    providers,
    runs: runs.map((r) => ({ ...r, usage: loads(r.usage_json), usage_json: undefined })),
    hourly,
    totals: {
      runs: totals?.runs ?? 0,
      completed: totals?.completed ?? 0,
      failed: totals?.failed ?? 0,
      active: totals?.active ?? 0,
      steps: totals?.steps ?? 0,
      pending_actions: pendingActions?.n ?? 0,
      tokens_today: tokensToday,
    },
  });
});
