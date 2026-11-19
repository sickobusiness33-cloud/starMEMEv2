// Registro de conectores y endpoints (crear, editar, probar, activar, desconectar).
//
// Estados: pending_config (faltan datos) · untested (sin probar o cambiado) ·
// connected (última prueba real correcta) · error (última prueba/uso falló).
// Solo se puede activar un conector en estado connected.

import { Hono } from "hono";
import { record } from "../audit";
import { requireUser } from "../auth";
import { decryptJson, encryptJson } from "../crypto";
import { all, dumps, loads, nowIso, one, run, update } from "../db";
import type { AppEnv, Env } from "../env";
import { fail, jsonBody, objOf, reqStr, str, toId } from "../http";
import { type Connector, ConnectorError, validateFields } from "./base";
import { GitHubConnector } from "./github";
import { DiscordWebhookConnector, SlackWebhookConnector } from "./webhooks";

export { ConnectorError };

type ConnectorClass = (new (config: Record<string, string>, secrets: Record<string, string>) => Connector) & typeof Connector;

export const CONNECTORS: Record<string, ConnectorClass> = {
  github: GitHubConnector as unknown as ConnectorClass,
  discord_webhook: DiscordWebhookConnector as unknown as ConnectorClass,
  slack_webhook: SlackWebhookConnector as unknown as ConnectorClass,
};

export async function instantiate(env: Env, row: any): Promise<Connector> {
  const Cls = CONNECTORS[row.type];
  return new Cls(loads(row.config_json), await decryptJson(env.ENCRYPTION_KEY, row.secret_enc));
}

/** Representación para el navegador: NUNCA incluye valores secretos. */
export async function publicConnector(env: Env, row: any) {
  const Cls = CONNECTORS[row.type];
  const stored = row.secret_enc ? await decryptJson(env.ENCRYPTION_KEY, row.secret_enc) : {};
  const secretNames = Cls ? Cls.type.fields.filter((f) => f.secret).map((f) => f.name) : [];
  const projects = await all<{ name: string }>(
    env.DB,
    "SELECT p.name FROM project_connectors pc JOIN projects p ON p.id = pc.project_id WHERE pc.connector_id = ? ORDER BY p.name",
    row.id,
  );
  return {
    id: row.id,
    type: row.type,
    type_name: Cls?.type.name ?? row.type,
    name: row.name,
    config: loads(row.config_json),
    secrets_set: Object.fromEntries(secretNames.map((n) => [n, Boolean(stored[n])])),
    enabled: Boolean(row.enabled),
    status: row.status,
    last_error: row.last_error,
    last_tested_at: row.last_tested_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    projects: projects.map((p) => p.name),
  };
}

function split(Cls: ConnectorClass, config: Record<string, unknown>, secrets: Record<string, unknown>) {
  const pub: Record<string, string> = {};
  const sec: Record<string, string> = {};
  for (const f of Cls.type.fields) {
    const src = f.secret ? secrets : config;
    const v = src[f.name];
    if (typeof v !== "string") continue;
    if (f.secret) {
      if (v.trim()) sec[f.name] = v.trim().slice(0, 1000);
    } else pub[f.name] = v.trim().slice(0, 300);
  }
  return { pub, sec };
}

const statusFor = (Cls: ConnectorClass, config: Record<string, string>, secrets: Record<string, string>) =>
  new Cls(config, secrets).missingFields().length ? "pending_config" : "untested";

export const connectorRoutes = new Hono<AppEnv>();
connectorRoutes.use("*", requireUser);

async function owned(c: any, id: number) {
  const row = await one<any>(c.env.DB, "SELECT * FROM connectors WHERE id = ? AND owner_id = ?", id, c.get("user").id);
  if (!row) fail(404, "Conector no encontrado.");
  return row;
}

connectorRoutes.get("/types", (c) => c.json(Object.values(CONNECTORS).map((C) => C.type)));

connectorRoutes.get("/", async (c) => {
  const rows = await all<any>(c.env.DB, "SELECT * FROM connectors WHERE owner_id = ? ORDER BY id", c.get("user").id);
  return c.json(await Promise.all(rows.map((r) => publicConnector(c.env, r))));
});

connectorRoutes.post("/", async (c) => {
  const u = c.get("user");
  const body = await jsonBody(c.req.raw);
  const type = reqStr(body, "type", { label: "tipo", min: 1, max: 50 });
  const name = reqStr(body, "name", { label: "nombre", min: 1, max: 80 });
  const Cls = CONNECTORS[type];
  if (!Cls) fail(400, "Tipo de conector desconocido.");
  const { pub, sec } = split(Cls, objOf(body, "config"), objOf(body, "secrets"));
  const errors = validateFields(Cls.type, pub, sec);
  if (errors.length) fail(422, errors.join(" "));
  const now = nowIso();
  const id = await run(
    c.env.DB,
    "INSERT INTO connectors (owner_id, type, name, config_json, secret_enc, enabled, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
    u.id,
    type,
    name,
    dumps(pub),
    Object.keys(sec).length ? await encryptJson(c.env.ENCRYPTION_KEY, sec) : null,
    statusFor(Cls, pub, sec),
    now,
    now,
  );
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "conector.crear", target: `${type}:${name}` });
  return c.json(await publicConnector(c.env, await owned(c, id)));
});

connectorRoutes.patch("/:id", async (c) => {
  const u = c.get("user");
  const id = toId(c.req.param("id"));
  const row = await owned(c, id);
  const Cls = CONNECTORS[row.type];
  const body = await jsonBody(c.req.raw);
  const name = str(body, "name", { label: "nombre", min: 1, max: 80, optional: true }) ?? row.name;
  const config = loads<Record<string, string>>(row.config_json);
  const secrets = await decryptJson(c.env.ENCRYPTION_KEY, row.secret_enc);
  const { pub, sec } = split(Cls, objOf(body, "config"), objOf(body, "secrets"));
  const changed = Object.keys(pub).some((k) => pub[k] !== config[k]) || Object.keys(sec).length > 0;
  Object.assign(config, pub);
  Object.assign(secrets, sec);
  const errors = validateFields(Cls.type, config, secrets);
  if (errors.length) fail(422, errors.join(" "));
  const fields: Record<string, unknown> = {
    name,
    config_json: dumps(config),
    secret_enc: Object.keys(secrets).length ? await encryptJson(c.env.ENCRYPTION_KEY, secrets) : null,
    updated_at: nowIso(),
  };
  if (changed) Object.assign(fields, { status: statusFor(Cls, config, secrets), enabled: 0, last_error: null });
  await update(c.env.DB, "connectors", id, fields);
  await record(c.env.DB, {
    actor: u.email,
    userId: u.id,
    action: "conector.editar",
    target: row.name,
    detail: changed ? "credenciales/configuración cambiadas; requiere nueva prueba" : "nombre",
  });
  return c.json(await publicConnector(c.env, await owned(c, id)));
});

connectorRoutes.post("/:id/test", async (c) => {
  const u = c.get("user");
  const id = toId(c.req.param("id"));
  const row = await owned(c, id);
  const connector = await instantiate(c.env, row);
  const missing = connector.missingFields();
  let message: string;
  let status: string;
  let ok = false;
  if (missing.length) {
    message = `Pendiente de configuración: falta ${missing.join(", ")}.`;
    status = "pending_config";
  } else {
    try {
      message = await connector.test();
      status = "connected";
      ok = true;
    } catch (err) {
      message = err instanceof ConnectorError ? err.message : "Error inesperado al probar la conexión.";
      status = "error";
    }
  }
  const fields: Record<string, unknown> = { status, last_error: ok ? null : message, last_tested_at: nowIso() };
  if (!ok) fields.enabled = 0;
  await update(c.env.DB, "connectors", id, fields);
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "conector.probar", target: row.name, result: ok ? "ok" : "error", detail: message });
  return c.json({ ok, message, connector: await publicConnector(c.env, await owned(c, id)) });
});

connectorRoutes.post("/:id/enable", async (c) => {
  const u = c.get("user");
  const id = toId(c.req.param("id"));
  const row = await owned(c, id);
  const body = await jsonBody(c.req.raw);
  const enabled = body.enabled === true;
  if (enabled && row.status !== "connected") fail(409, "Solo se puede activar un conector cuya prueba de conexión haya sido correcta.");
  await update(c.env.DB, "connectors", id, { enabled: enabled ? 1 : 0, updated_at: nowIso() });
  await record(c.env.DB, { actor: u.email, userId: u.id, action: enabled ? "conector.activar" : "conector.desactivar", target: row.name });
  return c.json(await publicConnector(c.env, await owned(c, id)));
});

connectorRoutes.delete("/:id", async (c) => {
  const u = c.get("user");
  const id = toId(c.req.param("id"));
  const row = await owned(c, id);
  if (c.req.query("confirm") !== "true") fail(428, "Desconectar borra las credenciales guardadas. Confirma la acción.");
  await run(c.env.DB, "DELETE FROM connectors WHERE id = ?", id);
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "conector.desconectar", target: row.name, detail: "Credenciales eliminadas" });
  return c.json({ ok: true });
});
