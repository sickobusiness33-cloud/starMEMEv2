// API del Autopilot / Mission Control. Todo filtrado por el dueño: cada usuario solo ve y
// aprueba lo suyo. Los estados que se muestran salen de ap_tasks/ap_events (nunca inventados).

import { Hono } from "hono";
import { record } from "../audit";
import { requireUser } from "../auth";
import { all, loads, nowIso, one, run } from "../db";
import type { AppEnv } from "../env";
import { fail } from "../http";
import { hit } from "../ratelimit";
import { approveTask, LIMITS, rejectTask, tokensToday } from "./engine";
import { ROLES } from "./roles";

export const autopilotRoutes = new Hono<AppEnv>();
autopilotRoutes.use("*", requireUser);

const int = (v: unknown, min: number, max: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def;
};
const MAX_GOALS = 10;

async function ownGoal(c: any, id: number) {
  const g = await one<any>(c.env.DB, "SELECT * FROM ap_goals WHERE id = ? AND user_id = ?", id, c.get("user").id);
  if (!g) fail(404, "Ese objetivo no existe.");
  return g;
}
async function limitWrites(c: any) {
  const wait = await hit(c.env.DB, `autopilot:${c.get("user").id}`, 30, 60);
  if (wait) fail(429, `Demasiadas acciones seguidas. Espera ${wait}s.`);
}

// ------------------------------------------------------------------ objetivos
autopilotRoutes.get("/goals", async (c) => {
  const u = c.get("user");
  const goals = await all<any>(c.env.DB,
    `SELECT g.*, p.name AS project_name,
      (SELECT COUNT(*) FROM ap_tasks t WHERE t.goal_id = g.id) AS tasks,
      (SELECT COUNT(*) FROM ap_tasks t WHERE t.goal_id = g.id AND t.status = 'done') AS done,
      (SELECT COUNT(*) FROM ap_tasks t WHERE t.goal_id = g.id AND t.status = 'needs_approval') AS approvals
     FROM ap_goals g LEFT JOIN projects p ON p.id = g.project_id WHERE g.user_id = ? ORDER BY g.id DESC`, u.id);
  for (const g of goals) g.tokens_today = await tokensToday(c.env, g.id);
  return c.json({ goals });
});

autopilotRoutes.post("/goals", async (c) => {
  await limitWrites(c);
  const u = c.get("user");
  const b = await c.req.json<any>().catch(() => ({}));
  const title = String(b.title ?? "").trim();
  if (title.length < 5 || title.length > 200) fail(422, "El objetivo necesita un título de 5 a 200 caracteres.");
  const description = String(b.description ?? "").trim().slice(0, 4000);
  const n = (await one<any>(c.env.DB, "SELECT COUNT(*) AS n FROM ap_goals WHERE user_id = ? AND status != 'done'", u.id))?.n ?? 0;
  if (n >= MAX_GOALS) fail(409, `Máximo ${MAX_GOALS} objetivos abiertos.`);
  let projectId: number | null = null;
  if (b.project_id) {
    const p = await one<any>(c.env.DB, "SELECT id FROM projects WHERE id = ? AND owner_id = ?", Number(b.project_id), u.id);
    if (!p) fail(404, "Ese proyecto no existe.");
    projectId = p.id;
  }
  const now = nowIso();
  const id = await run(c.env.DB,
    "INSERT INTO ap_goals (user_id, project_id, title, description, status, cadence_minutes, max_tasks_per_cycle, max_cycles_per_day, token_budget_day, next_cycle_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'paused', ?, ?, ?, ?, NULL, ?, ?)",
    u.id, projectId, title, description,
    int(b.cadence_minutes, 15, 1440, 60), int(b.max_tasks_per_cycle, 1, 5, 3), int(b.max_cycles_per_day, 1, 48, 12), int(b.token_budget_day, 5000, 500000, 60000), now, now);
  await record(c.env.DB, { actor: u.email, userId: u.id, projectId, action: "autopilot.objetivo", target: String(id), detail: title.slice(0, 120) });
  return c.json({ id }, 201);
});

autopilotRoutes.patch("/goals/:id", async (c) => {
  await limitWrites(c);
  const g = await ownGoal(c, Number(c.req.param("id")));
  const b = await c.req.json<any>().catch(() => ({}));
  await run(c.env.DB, "UPDATE ap_goals SET title = ?, description = ?, cadence_minutes = ?, max_tasks_per_cycle = ?, max_cycles_per_day = ?, token_budget_day = ?, updated_at = ? WHERE id = ?",
    String(b.title ?? g.title).trim().slice(0, 200) || g.title, String(b.description ?? g.description).slice(0, 4000),
    int(b.cadence_minutes, 15, 1440, g.cadence_minutes), int(b.max_tasks_per_cycle, 1, 5, g.max_tasks_per_cycle),
    int(b.max_cycles_per_day, 1, 48, g.max_cycles_per_day), int(b.token_budget_day, 5000, 500000, g.token_budget_day), nowIso(), g.id);
  return c.json({ ok: true });
});

autopilotRoutes.post("/goals/:id/:action{start|pause|run|done}", async (c) => {
  await limitWrites(c);
  const u = c.get("user");
  const g = await ownGoal(c, Number(c.req.param("id")));
  const action = c.req.param("action");
  const now = nowIso();
  if (action === "pause" || action === "done") {
    await run(c.env.DB, "UPDATE ap_goals SET status = ?, paused_reason = ?, updated_at = ? WHERE id = ?", action === "done" ? "done" : "paused", action === "pause" ? "Pausado por ti" : null, now, g.id);
    // Lo que no ha empezado vuelve a pendiente; lo que corre termina su intento actual.
    await run(c.env.DB, "UPDATE ap_tasks SET status = 'pending', updated_at = ? WHERE goal_id = ? AND status IN ('queued','waiting')", now, g.id);
  } else {
    await run(c.env.DB, "UPDATE ap_goals SET status = 'active', paused_reason = NULL, next_cycle_at = ?, updated_at = ? WHERE id = ?", now, now, g.id);
    await c.env.RUNS.send({ apCycle: g.id });
  }
  await record(c.env.DB, { actor: u.email, userId: u.id, action: `autopilot.${action}`, target: String(g.id) });
  return c.json({ ok: true });
});

autopilotRoutes.delete("/goals/:id", async (c) => {
  await limitWrites(c);
  const g = await ownGoal(c, Number(c.req.param("id")));
  const busy = (await one<any>(c.env.DB, "SELECT COUNT(*) AS n FROM ap_tasks WHERE goal_id = ? AND status = 'running'", g.id))?.n ?? 0;
  if (busy) fail(409, "Hay tareas ejecutándose. Pausa el objetivo y espera a que terminen.");
  await run(c.env.DB, "DELETE FROM ap_tasks WHERE goal_id = ?", g.id);
  await run(c.env.DB, "DELETE FROM ap_memory WHERE goal_id = ?", g.id);
  await run(c.env.DB, "DELETE FROM ap_goals WHERE id = ?", g.id);
  await record(c.env.DB, { actor: c.get("user").email, userId: c.get("user").id, action: "autopilot.borrar", target: String(g.id) });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ tareas y aprobaciones
autopilotRoutes.get("/tasks", async (c) => {
  const u = c.get("user");
  const status = c.req.query("status");
  const goal = Number(c.req.query("goal") || 0);
  const where = ["user_id = ?"]; const args: unknown[] = [u.id];
  if (status) { where.push(`status IN (${status.split(",").slice(0, 10).map(() => "?").join(",")})`); args.push(...status.split(",").slice(0, 10)); }
  if (goal) { where.push("goal_id = ?"); args.push(goal); }
  const tasks = await all<any>(c.env.DB,
    `SELECT id, goal_id, cycle, title, detail, role, status, risk, attempts, max_attempts, escalated, action_json, last_action,
      substr(result, 1, 4000) AS result, error, provider, model, started_at, finished_at, created_at, updated_at
     FROM ap_tasks WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 200`, ...args);
  for (const t of tasks) t.action = loads(t.action_json, null), delete t.action_json;
  return c.json({ tasks });
});

autopilotRoutes.post("/tasks/:id/approve", async (c) => {
  await limitWrites(c);
  const u = c.get("user");
  const id = Number(c.req.param("id"));
  const r = await approveTask(c.env, id, u.id);
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "autopilot.aprobar", target: String(id), result: r.ok ? "ok" : "error", detail: r.message.slice(0, 200) });
  if (!r.ok) fail(409, r.message);
  return c.json(r);
});

autopilotRoutes.post("/tasks/:id/reject", async (c) => {
  await limitWrites(c);
  const u = c.get("user");
  const id = Number(c.req.param("id"));
  const b = await c.req.json<any>().catch(() => ({}));
  if (!(await rejectTask(c.env, id, u.id, String(b.reason ?? "").slice(0, 300)))) fail(409, "La tarea no está esperando aprobación.");
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "autopilot.rechazar", target: String(id) });
  return c.json({ ok: true });
});

autopilotRoutes.post("/tasks/:id/cancel", async (c) => {
  await limitWrites(c);
  const u = c.get("user");
  const n = await c.env.DB.prepare("UPDATE ap_tasks SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status IN ('pending','queued','waiting','needs_approval','blocked')")
    .bind(nowIso(), nowIso(), Number(c.req.param("id")), u.id).run();
  if (!n.meta.changes) fail(409, "Esa tarea no se puede cancelar ahora.");
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Mission Control
autopilotRoutes.get("/events", async (c) => {
  const u = c.get("user");
  const after = Number(c.req.query("after") || 0);
  const events = await all<any>(c.env.DB, "SELECT id, goal_id, task_id, kind, agent, target, message, created_at FROM ap_events WHERE user_id = ? AND id > ? ORDER BY id DESC LIMIT 120", u.id, after);
  return c.json({ events });
});

autopilotRoutes.get("/memory", async (c) => {
  const u = c.get("user");
  const goal = Number(c.req.query("goal") || 0);
  const memory = goal
    ? await all<any>(c.env.DB, "SELECT id, goal_id, kind, content, source_task_id, created_at FROM ap_memory WHERE user_id = ? AND goal_id = ? ORDER BY id DESC LIMIT 100", u.id, goal)
    : await all<any>(c.env.DB, "SELECT id, goal_id, kind, content, source_task_id, created_at FROM ap_memory WHERE user_id = ? ORDER BY id DESC LIMIT 100", u.id);
  return c.json({ memory });
});

/** Estado real de cada agente: WORKING solo si tiene una tarea «running»/«review» ahora mismo. */
autopilotRoutes.get("/mission", async (c) => {
  const u = c.get("user");
  const db = c.env.DB;
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const active = await all<any>(db, "SELECT id, goal_id, title, role, status, last_action, started_at, updated_at, attempts FROM ap_tasks WHERE user_id = ? AND status IN ('running','review','needs_approval','queued','waiting')", u.id);
  const lastByRole = await all<any>(db,
    `SELECT e.agent, e.message, e.created_at FROM ap_events e JOIN (SELECT agent, MAX(id) AS mid FROM ap_events WHERE user_id = ? GROUP BY agent) m ON m.mid = e.id`, u.id);
  const lastResult = await all<any>(db,
    `SELECT t.role, t.title, t.status, t.finished_at FROM ap_tasks t JOIN (SELECT role, MAX(id) AS mid FROM ap_tasks WHERE user_id = ? AND status IN ('done','failed','blocked','cancelled') GROUP BY role) m ON m.mid = t.id`, u.id);
  const activeGoals = (await one<any>(db, "SELECT COUNT(*) AS n FROM ap_goals WHERE user_id = ? AND status = 'active'", u.id))?.n ?? 0;
  // Un ciclo está en curso si su evento «cycle» es reciente y el Planner aún no ha contestado después.
  const lastCycle = await one<any>(db, "SELECT MAX(id) AS id FROM ap_events WHERE user_id = ? AND kind = 'cycle' AND created_at >= ?", u.id, new Date(Date.now() - 5 * 60_000).toISOString());
  const planned = lastCycle?.id ? await one<any>(db, "SELECT id FROM ap_events WHERE user_id = ? AND id > ? AND agent = 'planner' AND kind IN ('decision','error') LIMIT 1", u.id, lastCycle.id) : null;
  const cycling = Boolean(lastCycle?.id && !planned);

  const now = Date.now();
  const agents = ROLES.map((r) => {
    const mine = active.filter((t) => t.role === r.id);
    const working = mine.find((t) => t.status === "running" || t.status === "review");
    const approval = mine.find((t) => t.status === "needs_approval");
    const queued = mine.find((t) => t.status === "queued" || t.status === "waiting");
    let state = "IDLE";
    let task = working ?? approval ?? queued ?? null;
    if (working) state = working.status === "review" ? "REVIEW" : "WORKING";
    else if (approval) state = "NEEDS_APPROVAL";
    else if (queued) state = queued.status === "waiting" ? "WAITING" : "QUEUED";
    // El orquestador/planificador trabajan durante un ciclo (evento reciente), el reviewer con tareas en «review».
    if (r.id === "reviewer") { const rv = active.find((t) => t.status === "review"); if (rv) { state = "WORKING"; task = rv; } }
    if ((r.id === "orchestrator" || r.id === "planner") && cycling) state = "WORKING";
    const last = lastByRole.find((e) => e.agent === r.id);
    const res = lastResult.find((t) => t.role === r.id);
    return {
      id: r.id, name: r.name, purpose: r.purpose, tools: r.tools, state,
      task: task ? { id: task.id, title: task.title, status: task.status, attempts: task.attempts } : null,
      running_seconds: working?.started_at ? Math.max(0, Math.round((now - Date.parse(working.started_at)) / 1000)) : 0,
      last_action: working?.last_action ?? last?.message ?? null,
      last_action_at: last?.created_at ?? null,
      last_result: res ? { title: res.title, status: res.status, at: res.finished_at } : null,
    };
  });

  const counts = await all<any>(db, "SELECT status, COUNT(*) AS n FROM ap_tasks WHERE user_id = ? GROUP BY status", u.id);
  const usage = await one<any>(db,
    "SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd, COALESCE(SUM(latency_ms), 0) AS runtime_ms, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors FROM usage_events WHERE user_id = ? AND kind = 'autopilot' AND created_at >= ?",
    u.id, since);
  const models = await all<any>(db, "SELECT provider, model, COUNT(*) AS calls FROM usage_events WHERE user_id = ? AND kind = 'autopilot' AND created_at >= ? GROUP BY provider, model ORDER BY calls DESC LIMIT 6", u.id, since);
  const hourly = await all<any>(db, "SELECT substr(created_at, 1, 13) AS h, COUNT(*) AS n FROM ap_events WHERE user_id = ? AND created_at >= ? GROUP BY h ORDER BY h", u.id, since);
  const tools = await all<any>(db, "SELECT substr(message, 1, instr(message || ' ', ' ') - 1) AS tool, COUNT(*) AS n FROM ap_events WHERE user_id = ? AND kind = 'tool' AND created_at >= ? GROUP BY tool ORDER BY n DESC LIMIT 10", u.id, since);
  const links = await all<any>(db, "SELECT agent, target, COUNT(*) AS n FROM ap_events WHERE user_id = ? AND target IS NOT NULL AND created_at >= ? GROUP BY agent, target ORDER BY n DESC LIMIT 60", u.id, since);
  const errors = await all<any>(db, "SELECT id, agent, message, created_at FROM ap_events WHERE user_id = ? AND kind = 'error' ORDER BY id DESC LIMIT 10", u.id);
  const decisions = await all<any>(db, "SELECT id, agent, kind, message, created_at FROM ap_events WHERE user_id = ? AND kind IN ('decision','approval','escalate','limit') ORDER BY id DESC LIMIT 12", u.id);

  return c.json({
    active_goals: activeGoals,
    limits: LIMITS,
    agents,
    counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
    usage_24h: usage,
    models, hourly, tools, links, errors, decisions,
    working: agents.filter((a) => a.state === "WORKING").length,
  });
});
