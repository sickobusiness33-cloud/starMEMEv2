// Endpoints de ejecuciones (iniciar, listar, detener, cancelar, reintentar) y
// de acciones (confirmar/rechazar lo que pide la IA, o ejecutar a mano con confirmación).

import { Hono, type Context } from "hono";
import { record } from "./audit";
import { requireUser } from "./auth";
import { all, dumps, loads, nowIso, one, run } from "./db";
import type { AppEnv, Env, User } from "./env";
import { ACTIVE, REJECTED_MSG } from "./executor";
import { fail, jsonBody, objOf, reqStr, toId } from "./http";
import { DEFAULT_LIMITS, getConversation, getProject } from "./projects";
import { hit } from "./ratelimit";
import { TOOLS, execute, requiresConfirmation, toolOut } from "./tools";

const ACTIVE_SQL = `(${ACTIVE.map((s) => `'${s}'`).join(",")})`;

function actionOut(row: any) {
  const spec = TOOLS[row.tool_id];
  return { ...row, args: loads(row.args_json), tool: spec ? toolOut(spec) : null, is_error: Boolean(row.is_error) };
}

async function runOut(env: Env, row: any) {
  const { state_json, params_json, usage_json, ...rest } = row;
  const actions = await all<any>(env.DB, "SELECT * FROM actions WHERE run_id = ? ORDER BY id", row.id);
  return { ...rest, params: loads(params_json), usage: loads(usage_json), actions: actions.map(actionOut) };
}

async function runForUser(c: Context<AppEnv>, id: number) {
  const row = await one<any>(
    c.env.DB,
    "SELECT r.*, p.name AS project_name FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND p.owner_id = ?",
    id,
    c.get("user").id,
  );
  if (!row) fail(404, "Ejecución no encontrada.");
  return row;
}

async function createRun(c: Context<AppEnv>, project: any, convId: number, text: string, userMessageId: number | null, retryOf: number | null) {
  const u = c.get("user");
  const s = c.get("settings");
  if (project.status === "archived") fail(409, "El proyecto está archivado. Restáuralo para ejecutar tareas.");
  if (!project.provider || !project.model) fail(422, "Configura el proveedor y el modelo en Ajustes del proyecto antes de ejecutar.");
  const wait = await hit(c.env.DB, `runs:${u.id}`, s.runsPerMinute, 60);
  if (wait) fail(429, `Has alcanzado el límite de ${s.runsPerMinute} tareas por minuto. Espera ${wait} s.`);
  const limits = { ...DEFAULT_LIMITS, ...loads(project.limits_json) };
  const today = new Date().toISOString().slice(0, 10);
  const count = await one<any>(c.env.DB, "SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND created_at >= ?", project.id, today);
  if ((count?.n ?? 0) >= limits.max_runs_per_day) {
    fail(429, `Límite diario del proyecto alcanzado (${limits.max_runs_per_day} tareas). Puedes subirlo en Ajustes del proyecto.`);
  }
  const now = nowIso();
  const msgId =
    userMessageId ??
    (await run(c.env.DB, "INSERT INTO messages (conversation_id, project_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)", convId, project.id, text, now));
  const runId = await run(
    c.env.DB,
    "INSERT INTO runs (project_id, conversation_id, user_id, status, input, provider, model, params_json, retry_of, user_message_id, created_at)" +
      " VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
    project.id,
    convId,
    u.id,
    text,
    project.provider,
    project.model,
    project.params_json,
    retryOf,
    msgId,
    now,
  );
  await run(c.env.DB, "UPDATE messages SET run_id = ? WHERE id = ? AND run_id IS NULL", runId, msgId);
  await run(c.env.DB, "UPDATE conversations SET updated_at = ? WHERE id = ?", now, convId);
  await record(c.env.DB, {
    actor: u.email,
    userId: u.id,
    projectId: project.id,
    action: retryOf ? "ejecucion.reintentar" : "ejecucion.iniciar",
    target: `#${runId}`,
    detail: `${project.provider}/${project.model}${retryOf ? ` (reintento de #${retryOf})` : ""}`,
  });
  await c.env.RUNS.send({ runId });
  return runId;
}

export const runRoutes = new Hono<AppEnv>();
runRoutes.use("*", requireUser);

runRoutes.post("/projects/:id/runs", async (c) => {
  const project = await getProject(c, toId(c.req.param("id")));
  const body = await jsonBody(c.req.raw);
  const input = reqStr(body, "input", { label: "mensaje", min: 1, max: 50_000 });
  let convId: number;
  if (body.conversation_id) {
    convId = (await getConversation(c.env, project.id, toId(String(body.conversation_id)))).id;
  } else {
    const now = nowIso();
    const title = input.split("\n")[0].slice(0, 60) || "Conversación";
    convId = await run(c.env.DB, "INSERT INTO conversations (project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", project.id, title, now, now);
  }
  const runId = await createRun(c, project, convId, input, null, null);
  return c.json(await runOut(c.env, await runForUser(c, runId)));
});

runRoutes.get("/projects/:id/runs", async (c) => {
  const project = await getProject(c, toId(c.req.param("id")));
  let sql = "SELECT r.*, p.name AS project_name FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.project_id = ?";
  const params: unknown[] = [project.id];
  const conv = c.req.query("conversation_id");
  if (conv) {
    sql += " AND r.conversation_id = ?";
    params.push(Number(conv));
  }
  const status = c.req.query("status");
  if (status) {
    sql += " AND r.status = ?";
    params.push(status);
  }
  const q = (c.req.query("q") || "").trim();
  if (q) {
    sql += " AND (r.input LIKE ? OR r.output LIKE ? OR r.error LIKE ?)";
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += " ORDER BY r.id DESC LIMIT 200";
  const rows = await all<any>(c.env.DB, sql, ...params);
  return c.json(await Promise.all(rows.map((r) => runOut(c.env, r))));
});

runRoutes.get("/runs", async (c) => {
  let sql =
    "SELECT r.*, p.name AS project_name, p.color AS project_color FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.owner_id = ?";
  if (c.req.query("active") === "true") sql += ` AND r.status IN ${ACTIVE_SQL}`;
  sql += " ORDER BY r.id DESC LIMIT 50";
  const rows = await all<any>(c.env.DB, sql, c.get("user").id);
  return c.json(await Promise.all(rows.map((r) => runOut(c.env, r))));
});

runRoutes.get("/runs/:id", async (c) => c.json(await runOut(c.env, await runForUser(c, toId(c.req.param("id"))))));

async function finish(c: Context<AppEnv>, id: number, from: string[], status: string, error: string, action: string) {
  const u = c.get("user");
  const r = await runForUser(c, id);
  const res = await c.env.DB.prepare(
    `UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
  )
    .bind(status, error, nowIso(), id, ...from)
    .run();
  if (!res.meta.changes) {
    fail(409, status === "stopped" ? "Solo se puede detener una ejecución en curso. Usa Cancelar si está en cola o en espera." : "La ejecución ya terminó.");
  }
  await run(c.env.DB, "UPDATE actions SET status = 'cancelled', decided_at = ? WHERE run_id = ? AND status = 'pending'", nowIso(), id);
  await record(c.env.DB, { actor: u.email, userId: u.id, projectId: r.project_id, action, target: `#${id}` });
  return c.json(await runOut(c.env, await runForUser(c, id)));
}

runRoutes.post("/runs/:id/stop", (c) => finish(c, toId(c.req.param("id")), ["running"], "stopped", "Detenida por el usuario.", "ejecucion.detener"));

runRoutes.post("/runs/:id/cancel", (c) =>
  finish(c, toId(c.req.param("id")), ["pending", "awaiting_confirmation"], "cancelled", "Cancelada por el usuario.", "ejecucion.cancelar"),
);

runRoutes.post("/runs/:id/retry", async (c) => {
  const r = await runForUser(c, toId(c.req.param("id")));
  if (!["failed", "stopped", "cancelled"].includes(r.status)) fail(409, "Solo se pueden reintentar ejecuciones fallidas, detenidas o canceladas.");
  const project = await getProject(c, r.project_id);
  const newId = await createRun(c, project, r.conversation_id, r.input, r.user_message_id, r.id);
  return c.json(await runOut(c.env, await runForUser(c, newId)));
});

// --- Acciones (confirmaciones) ----------------------------------------------

async function actionForUser(c: Context<AppEnv>, id: number) {
  const row = await one<any>(
    c.env.DB,
    "SELECT a.* FROM actions a JOIN projects p ON p.id = a.project_id WHERE a.id = ? AND p.owner_id = ?",
    id,
    c.get("user").id,
  );
  if (!row) fail(404, "Acción no encontrada.");
  return row;
}

runRoutes.get("/actions", async (c) => {
  const status = c.req.query("status") ?? "pending";
  const rows = await all<any>(
    c.env.DB,
    "SELECT a.*, p.name AS project_name FROM actions a JOIN projects p ON p.id = a.project_id WHERE p.owner_id = ? AND (? = '' OR a.status = ?) ORDER BY a.id DESC LIMIT 100",
    c.get("user").id,
    status,
    status,
  );
  return c.json(rows.map(actionOut));
});

async function resolve(c: Context<AppEnv>, approve: boolean) {
  const u: User = c.get("user");
  const action = await actionForUser(c, toId(c.req.param("id")));
  // Reclamar la acción de forma atómica: nunca se ejecuta dos veces.
  const claim = await c.env.DB.prepare("UPDATE actions SET status = 'running', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .bind(u.email, nowIso(), action.id)
    .run();
  if (!claim.meta.changes) fail(409, "Esta acción ya fue resuelta.");
  const project = await one<any>(c.env.DB, "SELECT * FROM projects WHERE id = ?", action.project_id);
  let content: string;
  let isError: boolean;
  let status: string;
  if (approve) {
    [content, isError] = await execute(c.env, project, action.tool_id, loads(action.args_json));
    status = isError ? "failed" : "executed";
  } else {
    [content, isError, status] = [REJECTED_MSG, true, "rejected"];
  }
  await run(c.env.DB, "UPDATE actions SET status = ?, result = ?, is_error = ? WHERE id = ?", status, content, isError ? 1 : 0, action.id);
  await record(c.env.DB, {
    actor: u.email,
    userId: u.id,
    projectId: project.id,
    action: approve ? "herramienta.aprobada" : "herramienta.rechazada",
    target: action.tool_id,
    result: approve && isError ? "error" : "ok",
    detail: `solicitada por IA (ejecución #${action.run_id}); resultado: ${content.slice(0, 300)}`,
  });
  if (action.run_id) {
    const left = await one<any>(c.env.DB, "SELECT COUNT(*) AS n FROM actions WHERE run_id = ? AND status IN ('pending','running')", action.run_id);
    if (!left?.n) {
      const resumed = await c.env.DB.prepare("UPDATE runs SET status = 'pending' WHERE id = ? AND status = 'awaiting_confirmation'").bind(action.run_id).run();
      if (resumed.meta.changes) await c.env.RUNS.send({ runId: action.run_id });
    }
  }
  return c.json(actionOut(await one<any>(c.env.DB, "SELECT * FROM actions WHERE id = ?", action.id)));
}

runRoutes.post("/actions/:id/approve", (c) => resolve(c, true));
runRoutes.post("/actions/:id/reject", (c) => resolve(c, false));

runRoutes.post("/projects/:id/actions", async (c) => {
  const u = c.get("user");
  const project = await getProject(c, toId(c.req.param("id")));
  const body = await jsonBody(c.req.raw);
  const toolId = reqStr(body, "tool_id", { label: "herramienta", min: 1, max: 60 });
  const spec = TOOLS[toolId];
  if (!spec) fail(404, "Herramienta desconocida.");
  if (requiresConfirmation(spec) && body.confirm !== true) {
    fail(428, `«${spec.name}» es una acción de riesgo «${spec.risk}». Confirma para continuar.`);
  }
  const args = objOf(body, "args");
  const [content, isError] = await execute(c.env, project, toolId, args);
  const now = nowIso();
  const id = await run(
    c.env.DB,
    "INSERT INTO actions (project_id, run_id, tool_id, args_json, status, requested_by, decided_by, result, is_error, created_at, decided_at)" +
      " VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    project.id,
    toolId,
    dumps(args),
    isError ? "failed" : "executed",
    u.email,
    u.email,
    content,
    isError ? 1 : 0,
    now,
    now,
  );
  await record(c.env.DB, { actor: u.email, userId: u.id, projectId: project.id, action: "herramienta.manual", target: toolId, result: isError ? "error" : "ok", detail: content.slice(0, 300) });
  return c.json(actionOut(await one<any>(c.env.DB, "SELECT * FROM actions WHERE id = ?", id)));
});
