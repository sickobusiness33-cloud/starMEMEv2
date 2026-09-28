// Proyectos: CRUD, archivos, herramientas, conectores vinculados, conversaciones y búsqueda.
// Todo se consulta filtrando por project_id y dueño: los historiales no se mezclan.

import { Hono, type Context } from "hono";
import { record } from "./audit";
import { requireUser } from "./auth";
import { all, dumps, loads, nowIso, one, run, update } from "./db";
import type { AppEnv, Env, Settings } from "./env";
import { boolOf, fail, intIn, jsonBody, objOf, reqStr, str, toId } from "./http";
import { ProviderError, availableProviderIds, getProvider } from "./providers";
import { TOOLS, toolStatus } from "./tools";

export const COLORS = ["azul", "rosa", "morado", "verde", "turquesa", "naranja"];
export const DEFAULT_LIMITS = { max_runs_per_day: 100, history_messages: 20, max_tool_steps: 12 };
const EXTENSIONS = [
  ".txt", ".md", ".json", ".csv", ".tsv", ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css",
  ".yaml", ".yml", ".xml", ".log", ".toml", ".ini", ".sql", ".sh",
];
const FILE_NAME_RE = /^[\p{L}\p{N}_\-. ]{1,120}$/u;

export async function projectOut(env: Env, row: any) {
  const stats = await one<any>(
    env.DB,
    "SELECT COUNT(*) AS runs, SUM(status IN ('pending','running','awaiting_confirmation')) AS active, MAX(created_at) AS last_run FROM runs WHERE project_id = ?",
    row.id,
  );
  const files = await one<any>(env.DB, "SELECT COUNT(*) AS n FROM project_files WHERE project_id = ?", row.id);
  const tools = await one<any>(env.DB, "SELECT COUNT(*) AS n FROM project_tools WHERE project_id = ?", row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    color: row.color,
    status: row.status,
    provider: row.provider,
    model: row.model,
    params: loads(row.params_json),
    limits: { ...DEFAULT_LIMITS, ...loads(row.limits_json) },
    is_demo: Boolean(row.is_demo),
    created_at: row.created_at,
    updated_at: row.updated_at,
    run_count: stats?.runs ?? 0,
    active_runs: stats?.active ?? 0,
    last_run_at: stats?.last_run ?? null,
    file_count: files?.n ?? 0,
    tool_count: tools?.n ?? 0,
  };
}

export async function getProject(c: Context<AppEnv>, id: number) {
  const row = await one<any>(c.env.DB, "SELECT * FROM projects WHERE id = ? AND owner_id = ?", id, c.get("user").id);
  if (!row) fail(404, "Proyecto no encontrado.");
  return row;
}

async function validateAi(env: Env, settings: Settings, userId: number, provider: string, model: string, params: Record<string, unknown>) {
  if (!provider) return {};
  if (!availableProviderIds(settings).includes(provider)) fail(422, `Proveedor desconocido: ${provider}.`);
  try {
    return (await getProvider(env, settings, userId, provider)).cleanParams(model, params);
  } catch (err) {
    return fail(422, err instanceof ProviderError ? err.message : "Parámetros no válidos.");
  }
}

function readLimits(body: Record<string, unknown>) {
  const l = objOf(body, "limits");
  return {
    max_runs_per_day: intIn(l, "max_runs_per_day", "Tareas máximas al día", 1, 10_000, DEFAULT_LIMITS.max_runs_per_day),
    history_messages: intIn(l, "history_messages", "Mensajes de historial", 0, 200, DEFAULT_LIMITS.history_messages),
    max_tool_steps: intIn(l, "max_tool_steps", "Pasos máximos por tarea", 1, 40, DEFAULT_LIMITS.max_tool_steps),
  };
}

export const projectRoutes = new Hono<AppEnv>();
projectRoutes.use("*", requireUser);

projectRoutes.get("/", async (c) => {
  const q = (c.req.query("q") || "").trim();
  const status = c.req.query("status") || "active";
  let sql = "SELECT * FROM projects WHERE owner_id = ?";
  const params: unknown[] = [c.get("user").id];
  if (status === "active" || status === "archived") {
    sql += " AND status = ?";
    params.push(status);
  }
  if (q) {
    sql += " AND (name LIKE ? OR description LIKE ?)";
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += " ORDER BY updated_at DESC LIMIT 200";
  const rows = await all<any>(c.env.DB, sql, ...params);
  return c.json(await Promise.all(rows.map((r) => projectOut(c.env, r))));
});

projectRoutes.post("/", async (c) => {
  const u = c.get("user");
  const body = await jsonBody(c.req.raw);
  const name = reqStr(body, "name", { label: "nombre", min: 1, max: 80 });
  const description = str(body, "description", { label: "descripción", max: 500, optional: true }) ?? "";
  const instructions = str(body, "instructions", { label: "instrucciones", max: 20_000, optional: true, trim: false }) ?? "";
  const color = str(body, "color", { label: "color", max: 20, optional: true }) || "azul";
  if (!COLORS.includes(color)) fail(422, "Color no válido.");
  const provider = str(body, "provider", { label: "proveedor", max: 40, optional: true }) ?? "";
  const model = str(body, "model", { label: "modelo", max: 120, optional: true }) ?? "";
  const params = await validateAi(c.env, c.get("settings"), u.id, provider, model, objOf(body, "params"));
  const now = nowIso();
  const id = await run(
    c.env.DB,
    "INSERT INTO projects (owner_id, name, description, instructions, color, provider, model, params_json, limits_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    u.id,
    name,
    description,
    instructions,
    color,
    provider,
    model,
    dumps(params),
    dumps(readLimits(body)),
    now,
    now,
  );
  await record(c.env.DB, { actor: u.email, userId: u.id, projectId: id, action: "proyecto.crear", target: name });
  return c.json(await projectOut(c.env, await getProject(c, id)));
});

projectRoutes.get("/:id", async (c) => c.json(await projectOut(c.env, await getProject(c, toId(c.req.param("id"))))));

projectRoutes.patch("/:id", async (c) => {
  const u = c.get("user");
  const id = toId(c.req.param("id"));
  const row = await getProject(c, id);
  const body = await jsonBody(c.req.raw);
  const fields: Record<string, unknown> = {};
  const name = str(body, "name", { label: "nombre", min: 1, max: 80, optional: true });
  if (name !== undefined) fields.name = name;
  const description = str(body, "description", { label: "descripción", max: 500, optional: true });
  if (description !== undefined) fields.description = description;
  const instructions = str(body, "instructions", { label: "instrucciones", max: 20_000, optional: true, trim: false });
  if (instructions !== undefined) fields.instructions = instructions;
  const color = str(body, "color", { label: "color", max: 20, optional: true });
  if (color !== undefined) {
    if (!COLORS.includes(color)) fail(422, "Color no válido.");
    fields.color = color;
  }
  const status = str(body, "status", { label: "estado", max: 20, optional: true });
  if (status !== undefined) {
    if (!["active", "archived"].includes(status)) fail(422, "Estado no válido.");
    fields.status = status;
  }
  const provider = str(body, "provider", { label: "proveedor", max: 40, optional: true });
  const model = str(body, "model", { label: "modelo", max: 120, optional: true });
  if (provider !== undefined || model !== undefined || body.params !== undefined) {
    const p = provider ?? row.provider;
    const m = model ?? row.model;
    const params = body.params !== undefined ? objOf(body, "params") : loads(row.params_json);
    fields.provider = p;
    fields.model = m;
    fields.params_json = dumps(await validateAi(c.env, c.get("settings"), u.id, p, m, params));
  }
  if (body.limits !== undefined) fields.limits_json = dumps(readLimits(body));
  if (!Object.keys(fields).length) return c.json(await projectOut(c.env, row));
  fields.updated_at = nowIso();
  await update(c.env.DB, "projects", id, fields);
  const action = status && status !== row.status ? (status === "archived" ? "proyecto.archivar" : "proyecto.restaurar") : "proyecto.editar";
  await record(c.env.DB, { actor: u.email, userId: u.id, projectId: id, action, target: row.name, detail: `campos: ${Object.keys(body).join(", ")}` });
  return c.json(await projectOut(c.env, await getProject(c, id)));
});

projectRoutes.delete("/:id", async (c) => {
  const u = c.get("user");
  const id = toId(c.req.param("id"));
  const row = await getProject(c, id);
  if (c.req.query("confirm") !== "true") fail(428, "Eliminar un proyecto borra su historial, archivos y ejecuciones. Confirma la acción.");
  await run(c.env.DB, "DELETE FROM projects WHERE id = ?", id);
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "proyecto.eliminar", target: row.name, detail: `id=${id}` });
  return c.json({ ok: true });
});

// --- Archivos ----------------------------------------------------------------

const fileOut = (r: any) => ({
  id: r.id,
  name: r.name,
  size: r.size,
  created_by: r.created_by,
  created_at: r.created_at,
  include_in_context: Boolean(r.include_in_context),
});

async function getFile(env: Env, projectId: number, fileId: number) {
  const row = await one<any>(env.DB, "SELECT * FROM project_files WHERE id = ? AND project_id = ?", fileId, projectId);
  if (!row) fail(404, "Archivo no encontrado.");
  return row;
}

projectRoutes.get("/:id/files", async (c) => {
  const p = await getProject(c, toId(c.req.param("id")));
  const rows = await all<any>(
    c.env.DB,
    "SELECT id, name, size, include_in_context, created_by, created_at FROM project_files WHERE project_id = ? ORDER BY name",
    p.id,
  );
  return c.json(rows.map(fileOut));
});

projectRoutes.post("/:id/files", async (c) => {
  const u = c.get("user");
  const p = await getProject(c, toId(c.req.param("id")));
  const max = c.get("settings").maxFileBytes;
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) fail(422, "Adjunta un archivo en el campo «file».");
  const f = file as File;
  const name = f.name.split(/[\\/]/).pop()!.trim();
  if (!FILE_NAME_RE.test(name)) fail(422, "Nombre de archivo no válido (letras, números, espacios, - _ .).");
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  if (!EXTENSIONS.includes(ext)) fail(422, `Tipo no admitido. Solo texto: ${EXTENSIONS.join(", ")}`);
  if (f.size > max) fail(413, `El archivo supera el máximo de ${Math.round(max / 1024)} KB.`);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await f.arrayBuffer());
  } catch {
    return fail(422, "El archivo no es texto UTF-8.");
  }
  if (await one(c.env.DB, "SELECT id FROM project_files WHERE project_id = ? AND name = ?", p.id, name)) {
    fail(409, "Ya existe un archivo con ese nombre en el proyecto.");
  }
  const id = await run(
    c.env.DB,
    "INSERT INTO project_files (project_id, name, content, size, include_in_context, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
    p.id,
    name,
    content,
    f.size,
    u.email,
    nowIso(),
  );
  await record(c.env.DB, { actor: u.email, userId: u.id, projectId: p.id, action: "archivo.subir", target: name, detail: `${f.size} bytes` });
  return c.json(fileOut(await getFile(c.env, p.id, id)));
});

projectRoutes.patch("/:id/files/:fid", async (c) => {
  const p = await getProject(c, toId(c.req.param("id")));
  const fid = toId(c.req.param("fid"));
  await getFile(c.env, p.id, fid);
  const body = await jsonBody(c.req.raw);
  await run(c.env.DB, "UPDATE project_files SET include_in_context = ? WHERE id = ?", boolOf(body, "include_in_context") ? 1 : 0, fid);
  return c.json(fileOut(await getFile(c.env, p.id, fid)));
});

projectRoutes.get("/:id/files/:fid/download", async (c) => {
  const p = await getProject(c, toId(c.req.param("id")));
  const row = await getFile(c.env, p.id, toId(c.req.param("fid")));
  // Siempre adjunto de texto plano: nunca se interpreta como HTML.
  return new Response(row.content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

projectRoutes.delete("/:id/files/:fid", async (c) => {
  const u = c.get("user");
  const p = await getProject(c, toId(c.req.param("id")));
  const row = await getFile(c.env, p.id, toId(c.req.param("fid")));
  if (c.req.query("confirm") !== "true") fail(428, "Eliminar un archivo es irreversible. Confirma la acción.");
  await run(c.env.DB, "DELETE FROM project_files WHERE id = ?", row.id);
  await record(c.env.DB, { actor: u.email, userId: u.id, projectId: p.id, action: "archivo.eliminar", target: row.name });
  return c.json({ ok: true });
});

// --- Herramientas y conectores del proyecto ------------------------------

projectRoutes.get("/:id/tools", async (c) => c.json(await toolStatus(c.env, await getProject(c, toId(c.req.param("id"))))));

projectRoutes.put("/:id/tools/:tool", async (c) => {
  const u = c.get("user");
  const p = await getProject(c, toId(c.req.param("id")));
  const tool = c.req.param("tool");
  if (!(tool in TOOLS)) fail(404, "Herramienta desconocida.");
  const enabled = boolOf(await jsonBody(c.req.raw), "enabled");
  if (enabled) await run(c.env.DB, "INSERT OR IGNORE INTO project_tools (project_id, tool_id) VALUES (?, ?)", p.id, tool);
  else await run(c.env.DB, "DELETE FROM project_tools WHERE project_id = ? AND tool_id = ?", p.id, tool);
  await record(c.env.DB, { actor: u.email, userId: u.id, projectId: p.id, action: enabled ? "herramienta.habilitar" : "herramienta.deshabilitar", target: tool });
  return c.json(await toolStatus(c.env, p));
});

async function projectConnectors(env: Env, projectId: number, userId: number) {
  const rows = await all<any>(
    env.DB,
    "SELECT c.id, c.name, c.type, c.status, c.enabled, EXISTS(SELECT 1 FROM project_connectors pc WHERE pc.project_id = ? AND pc.connector_id = c.id) AS linked" +
      " FROM connectors c WHERE c.owner_id = ? ORDER BY c.name",
    projectId,
    userId,
  );
  return rows.map((r) => ({ ...r, linked: Boolean(r.linked), enabled: Boolean(r.enabled) }));
}

projectRoutes.get("/:id/connectors", async (c) => {
  const p = await getProject(c, toId(c.req.param("id")));
  return c.json(await projectConnectors(c.env, p.id, c.get("user").id));
});

projectRoutes.put("/:id/connectors/:cid", async (c) => {
  const u = c.get("user");
  const p = await getProject(c, toId(c.req.param("id")));
  const cid = toId(c.req.param("cid"));
  const conn = await one<any>(c.env.DB, "SELECT * FROM connectors WHERE id = ? AND owner_id = ?", cid, u.id);
  if (!conn) fail(404, "Conector no encontrado.");
  const linked = boolOf(await jsonBody(c.req.raw), "linked");
  if (linked) await run(c.env.DB, "INSERT OR IGNORE INTO project_connectors (project_id, connector_id) VALUES (?, ?)", p.id, cid);
  else await run(c.env.DB, "DELETE FROM project_connectors WHERE project_id = ? AND connector_id = ?", p.id, cid);
  await record(c.env.DB, { actor: u.email, userId: u.id, projectId: p.id, action: linked ? "conector.vincular" : "conector.desvincular", target: conn.name });
  return c.json(await projectConnectors(c.env, p.id, u.id));
});

// --- Conversaciones y búsqueda ------------------------------------------------

export async function getConversation(env: Env, projectId: number, convId: number) {
  const row = await one<any>(env.DB, "SELECT * FROM conversations WHERE id = ? AND project_id = ?", convId, projectId);
  if (!row) fail(404, "Conversación no encontrada en este proyecto.");
  return row;
}

projectRoutes.get("/:id/conversations", async (c) => {
  const p = await getProject(c, toId(c.req.param("id")));
  return c.json(
    await all(
      c.env.DB,
      "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count FROM conversations c WHERE c.project_id = ? ORDER BY c.updated_at DESC LIMIT 200",
      p.id,
    ),
  );
});

projectRoutes.get("/:id/conversations/:cid", async (c) => {
  const p = await getProject(c, toId(c.req.param("id")));
  const conv = await getConversation(c.env, p.id, toId(c.req.param("cid")));
  const messages = await all(c.env.DB, "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id", conv.id);
  return c.json({ conversation: conv, messages });
});

projectRoutes.delete("/:id/conversations/:cid", async (c) => {
  const u = c.get("user");
  const p = await getProject(c, toId(c.req.param("id")));
  const conv = await getConversation(c.env, p.id, toId(c.req.param("cid")));
  if (c.req.query("confirm") !== "true") fail(428, "Eliminar la conversación borra sus mensajes y ejecuciones. Confirma la acción.");
  await run(c.env.DB, "DELETE FROM conversations WHERE id = ?", conv.id);
  await record(c.env.DB, { actor: u.email, userId: u.id, projectId: p.id, action: "conversacion.eliminar", target: conv.title });
  return c.json({ ok: true });
});

projectRoutes.get("/:id/search", async (c) => {
  const p = await getProject(c, toId(c.req.param("id")));
  const q = (c.req.query("q") || "").trim();
  if (q.length < 2) fail(422, "Escribe al menos 2 caracteres para buscar.");
  const like = `%${q}%`;
  const messages = await all(
    c.env.DB,
    "SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title AS conversation_title FROM messages m JOIN conversations c ON c.id = m.conversation_id" +
      " WHERE m.project_id = ? AND m.content LIKE ? ORDER BY m.id DESC LIMIT 50",
    p.id,
    like,
  );
  const runs = await all(
    c.env.DB,
    "SELECT id, conversation_id, status, input, output, error, created_at FROM runs WHERE project_id = ? AND (input LIKE ? OR output LIKE ? OR error LIKE ?) ORDER BY id DESC LIMIT 50",
    p.id,
    like,
    like,
    like,
  );
  return c.json({ messages, runs });
});
