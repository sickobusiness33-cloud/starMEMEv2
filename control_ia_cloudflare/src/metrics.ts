// Métricas reales a partir de usage_events y agent_runs. Nunca se inventan:
// si no hay datos, los valores son 0 / vacíos.

import { Hono } from "hono";
import { requireAdmin, requireUser } from "./auth";
import { all, nowIso, one, run } from "./db";
import { record } from "./audit";
import type { AppEnv } from "./env";
import { claudeStatus, DEFAULT_PRIORITY, getAiSettings, type Source } from "./ai/router";
import { MODELS, publicModel } from "./ai/models";
import { fail, jsonBody } from "./http";
import { getSubscription, PLAN_LIMITS, usageToday } from "./plans";

export const metricsRoutes = new Hono<AppEnv>();

const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const daysOf = (v: string | undefined) => Math.min(90, Math.max(1, Number(v) || 7));

metricsRoutes.get("/ai/status", requireUser, async (c) => {
  const uid = c.get("user").id;
  const claude = await claudeStatus(c.env);
  const sub = await getSubscription(c.env.DB, uid);
  const settings = await getAiSettings(c.env.DB, uid);
  const keys = await all<any>(c.env.DB, "SELECT provider FROM user_provider_keys WHERE user_id = ?", uid);
  const ownClaude = keys.some((k) => k.provider === "anthropic");
  return c.json({
    plan: sub.plan,
    use_my_api: settings.use_my_api,
    priority: settings.priority,
    claude: {
      platform_configured: claude.configured,
      platform_available: claude.available,
      usable_by_you: (settings.use_my_api && ownClaude) || (PLAN_LIMITS[sub.plan].claude && claude.available),
      own_key: ownClaude,
      retry_after: claude.retry_after,
      reason: claude.last_error,
      model: claude.model,
    },
    own_keys: keys.map((k) => k.provider),
    free: { model: c.env.FREE_MODEL, fallback_model: c.env.FREE_MODEL_FALLBACK, image_model: c.env.IMAGE_MODEL, available: Boolean(c.env.AI) || c.env.AI_MODE === "mock" },
  });
});

/** Catálogo del Model Router con el estado real de cada modelo (enfriamiento tras errores). */
metricsRoutes.get("/ai/models", requireUser, async (c) => {
  const health = await all<any>(c.env.DB, "SELECT provider, available_after, last_error FROM provider_health WHERE provider LIKE 'model:%'");
  const now = Date.now();
  return c.json(
    MODELS.map((m) => {
      const h = health.find((x) => x.provider === `model:${m.id}`);
      const cooling = h?.available_after && new Date(h.available_after).getTime() > now;
      return { ...publicModel(m), status: cooling ? "cooldown" : "ready", retry_after: cooling ? h.available_after : null };
    }),
  );
});

metricsRoutes.get("/ai/settings", requireUser, async (c) => c.json(await getAiSettings(c.env.DB, c.get("user").id)));

metricsRoutes.put("/ai/settings", requireUser, async (c) => {
  const body = await jsonBody(c.req.raw);
  const cur = await getAiSettings(c.env.DB, c.get("user").id);
  const useMy = body.use_my_api === undefined ? cur.use_my_api : body.use_my_api === true;
  let priority = cur.priority;
  if (body.priority !== undefined) {
    const p = body.priority;
    if (!Array.isArray(p) || p.length !== DEFAULT_PRIORITY.length || new Set(p).size !== p.length || !p.every((x) => DEFAULT_PRIORITY.includes(x as Source))) {
      fail(422, "La prioridad debe ordenar exactamente: platform, user_api y free.");
    }
    priority = p as Source[];
  }
  await run(
    c.env.DB,
    "INSERT INTO user_ai_settings (user_id, use_my_api, priority_json, updated_at) VALUES (?, ?, ?, ?)" +
      " ON CONFLICT(user_id) DO UPDATE SET use_my_api = excluded.use_my_api, priority_json = excluded.priority_json, updated_at = excluded.updated_at",
    c.get("user").id,
    useMy ? 1 : 0,
    JSON.stringify(priority),
    nowIso(),
  );
  return c.json(await getAiSettings(c.env.DB, c.get("user").id));
});

metricsRoutes.get("/metrics/me", requireUser, async (c) => {
  const uid = c.get("user").id;
  const d = daysOf(c.req.query("days"));
  const sub = await getSubscription(c.env.DB, uid);
  const byProvider = await all(
    c.env.DB,
    "SELECT provider, model, COUNT(*) AS calls, SUM(ok) AS ok, SUM(fallback) AS fallbacks, CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms," +
      " SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM usage_events WHERE user_id = ? AND created_at >= ? GROUP BY provider, model ORDER BY calls DESC",
    uid,
    since(d),
  );
  return c.json({ days: d, plan: sub.plan, limits: PLAN_LIMITS[sub.plan], usage_today: await usageToday(c.env.DB, uid), by_provider: byProvider });
});

metricsRoutes.get("/metrics/admin", requireUser, requireAdmin, async (c) => {
  const d = daysOf(c.req.query("days"));
  const from = since(d);
  const totals = await one<any>(
    c.env.DB,
    "SELECT COUNT(*) AS calls, COALESCE(SUM(ok),0) AS ok, COALESCE(SUM(fallback),0) AS fallbacks, CAST(COALESCE(AVG(latency_ms),0) AS INTEGER) AS avg_latency_ms," +
      " COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(tokens_estimated),0) AS estimated_calls, COUNT(DISTINCT user_id) AS users FROM usage_events WHERE created_at >= ?",
    from,
  );
  const byProvider = await all(
    c.env.DB,
    "SELECT provider, model, COUNT(*) AS calls, SUM(ok) AS ok, SUM(fallback) AS fallbacks, CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms," +
      " SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, ROUND(SUM(cost_usd), 4) AS cost_usd FROM usage_events WHERE created_at >= ? GROUP BY provider, model ORDER BY calls DESC",
    from,
  );
  const byPlan = await all(c.env.DB, "SELECT plan, kind, COUNT(*) AS calls, ROUND(SUM(cost_usd), 4) AS cost_usd FROM usage_events WHERE created_at >= ? GROUP BY plan, kind", from);
  const byAgent = await all(
    c.env.DB,
    "SELECT agent_id, COUNT(*) AS runs, SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed, SUM(status = 'cancelled') AS cancelled," +
      " CAST(AVG(CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL THEN (julianday(finished_at) - julianday(started_at)) * 86400000 END) AS INTEGER) AS avg_duration_ms," +
      " SUM(notices_json <> '[]') AS with_fallback FROM agent_runs WHERE created_at >= ? GROUP BY agent_id ORDER BY runs DESC LIMIT 100",
    from,
  );
  const errors = await all(
    c.env.DB,
    "SELECT created_at, provider, model, kind, agent_id, error FROM usage_events WHERE ok = 0 AND created_at >= ? ORDER BY id DESC LIMIT 20",
    from,
  );
  const plans = await all(c.env.DB, "SELECT plan, subscription_status, COUNT(*) AS users FROM subscriptions GROUP BY plan, subscription_status");
  return c.json({ days: d, totals, by_provider: byProvider, by_plan: byPlan, by_agent: byAgent, recent_errors: errors, subscriptions: plans, claude: await claudeStatus(c.env) });
});

/** Reintentar Claude ya (p. ej. justo después de recargar créditos) sin esperar al enfriamiento. */
metricsRoutes.post("/metrics/admin/claude/retry", requireUser, requireAdmin, async (c) => {
  await run(c.env.DB, "UPDATE provider_health SET available_after = NULL, updated_at = ? WHERE provider = 'claude-platform'", nowIso());
  const u = c.get("user");
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "ai.claude.retry" });
  return c.json(await claudeStatus(c.env));
});
