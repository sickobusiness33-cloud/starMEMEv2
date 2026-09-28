// Registro de proveedores y endpoints de "Mis IAs" (claves propias de cada usuario).
//
// Para añadir un proveedor: subclase de Provider y añádela a PROVIDERS.

import { Hono } from "hono";
import { record } from "../audit";
import { requireUser } from "../auth";
import { decryptJson, encryptJson, redact } from "../crypto";
import { nowIso, one, run } from "../db";
import type { AppEnv, Env, Settings } from "../env";
import { fail, jsonBody, reqStr } from "../http";
import { notify } from "../notify";
import { AnthropicProvider } from "./anthropic";
import { type Provider, ProviderError, ProviderNotConfigured } from "./base";
import { DemoProvider } from "./demo";
import { OpenAIProvider } from "./openai";

export { ProviderError, ProviderNotConfigured };

type ProviderClass = new (settings: Settings, apiKey?: string) => Provider;
export const PROVIDERS: Record<string, ProviderClass> = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  demo: DemoProvider,
};

export function availableProviderIds(settings: Settings): string[] {
  return Object.keys(PROVIDERS).filter((id) => id !== "demo" || settings.enableDemoProvider);
}

export async function storedKey(env: Env, userId: number, providerId: string): Promise<string> {
  const row = await one<{ secret_enc: string }>(
    env.DB,
    "SELECT secret_enc FROM user_provider_keys WHERE user_id = ? AND provider = ?",
    userId,
    providerId,
  );
  return row ? (await decryptJson(env.ENCRYPTION_KEY, row.secret_enc)).api_key ?? "" : "";
}

/** Proveedor con la clave del usuario indicado (cada usuario usa SU clave). */
export async function getProvider(env: Env, settings: Settings, userId: number, providerId: string): Promise<Provider> {
  if (!availableProviderIds(settings).includes(providerId)) {
    throw new ProviderNotConfigured(`El proveedor '${providerId || "(ninguno)"}' no está disponible. Elige uno en Ajustes del proyecto.`);
  }
  const Cls = PROVIDERS[providerId];
  const probe = new Cls(settings);
  return new Cls(settings, probe.requiresKey ? await storedKey(env, userId, providerId) : "");
}

export async function markUsed(env: Env, userId: number, providerId: string) {
  await run(env.DB, "UPDATE user_provider_keys SET last_used_at = ? WHERE user_id = ? AND provider = ?", nowIso(), userId, providerId);
}

async function statusRow(env: Env, settings: Settings, userId: number, providerId: string) {
  const p = await getProvider(env, settings, userId, providerId);
  const row = await one<any>(env.DB, "SELECT * FROM user_provider_keys WHERE user_id = ? AND provider = ?", userId, providerId);
  const problem = p.configurationProblem();
  return {
    id: providerId,
    name: p.name,
    description: p.description,
    requires_key: p.requiresKey,
    key_help: p.keyHelp,
    is_demo: p.isDemo,
    key_source: row ? "cuenta" : null,
    configured: problem === null,
    problem,
    status: row?.status ?? (p.requiresKey ? "unknown" : "unknown"),
    last_error: row?.last_error ?? null,
    last_tested_at: row?.last_tested_at ?? null,
    last_used_at: row?.last_used_at ?? null,
  };
}

const modelsCache = new Map<string, { at: number; names: string[] }>();

export const providerRoutes = new Hono<AppEnv>();
providerRoutes.use("*", requireUser);

const checkId = (settings: Settings, id: string) => {
  if (!availableProviderIds(settings).includes(id)) fail(404, "Proveedor desconocido.");
};

providerRoutes.get("/", async (c) => {
  const s = c.get("settings");
  const u = c.get("user");
  return c.json(await Promise.all(availableProviderIds(s).map((id) => statusRow(c.env, s, u.id, id))));
});

providerRoutes.put("/:id/key", async (c) => {
  const s = c.get("settings");
  const u = c.get("user");
  const id = c.req.param("id");
  checkId(s, id);
  if (!new PROVIDERS[id](s).requiresKey) fail(400, "Este proveedor no usa API key.");
  const body = await jsonBody(c.req.raw);
  const key = reqStr(body, "api_key", { label: "API key", min: 8, max: 500 });
  await run(
    c.env.DB,
    "INSERT INTO user_provider_keys (user_id, provider, secret_enc, status, updated_at) VALUES (?, ?, ?, 'unknown', ?)" +
      " ON CONFLICT(user_id, provider) DO UPDATE SET secret_enc = excluded.secret_enc, status = 'unknown', last_error = NULL, updated_at = excluded.updated_at",
    u.id,
    id,
    await encryptJson(c.env.ENCRYPTION_KEY, { api_key: key }),
    nowIso(),
  );
  modelsCache.delete(`${u.id}:${id}`);
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "ia.conectar_clave", target: id });
  await notify(c.env, u.id, { category: "seguridad", title: `API key de ${id} guardada`, body: "Se guarda cifrada y nunca se muestra. Actívala en Ajustes → Usar mi API.", link: "#/configuracion" });
  return c.json(await statusRow(c.env, s, u.id, id));
});

providerRoutes.delete("/:id/key", async (c) => {
  const s = c.get("settings");
  const u = c.get("user");
  const id = c.req.param("id");
  checkId(s, id);
  await run(c.env.DB, "DELETE FROM user_provider_keys WHERE user_id = ? AND provider = ?", u.id, id);
  modelsCache.delete(`${u.id}:${id}`);
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "ia.borrar_clave", target: id });
  await notify(c.env, u.id, { category: "seguridad", title: `API key de ${id} eliminada`, link: "#/configuracion" });
  return c.json(await statusRow(c.env, s, u.id, id));
});

providerRoutes.post("/:id/test", async (c) => {
  const s = c.get("settings");
  const u = c.get("user");
  const id = c.req.param("id");
  checkId(s, id);
  const p = await getProvider(c.env, s, u.id, id);
  let message: string;
  let ok = false;
  try {
    p.ensureConfigured();
    message = await p.test();
    ok = true;
  } catch (err) {
    message = redact(err instanceof ProviderError ? err.message : "Error inesperado al probar la conexión.");
  }
  await run(
    c.env.DB,
    "UPDATE user_provider_keys SET status = ?, last_error = ?, last_tested_at = ? WHERE user_id = ? AND provider = ?",
    ok ? "ok" : "error",
    ok ? null : message,
    nowIso(),
    u.id,
    id,
  );
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "ia.probar", target: id, result: ok ? "ok" : "error", detail: message });
  return c.json({ ok, message, provider: await statusRow(c.env, s, u.id, id) });
});

providerRoutes.get("/:id/models", async (c) => {
  const s = c.get("settings");
  const u = c.get("user");
  const id = c.req.param("id");
  checkId(s, id);
  const model = c.req.query("model") || "";
  const p = await getProvider(c.env, s, u.id, id);
  let names: string[];
  let verified = false;
  let warning: string | null = null;
  const cached = modelsCache.get(`${u.id}:${id}`);
  if (cached && Date.now() - cached.at < 600_000) {
    names = cached.names;
    verified = true;
  } else if (p.configurationProblem()) {
    names = p.suggestedModels();
    warning = p.configurationProblem();
  } else {
    try {
      names = await p.listModels();
      verified = !p.isDemo;
      modelsCache.set(`${u.id}:${id}`, { at: Date.now(), names });
    } catch (err) {
      names = p.suggestedModels();
      warning = `No se pudo consultar la lista real de modelos: ${redact(err instanceof ProviderError ? err.message : err)}`;
    }
  }
  return c.json({ models: names, verified, warning, params: model ? p.paramsFor(model) : [] });
});
