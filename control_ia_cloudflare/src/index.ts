// Punto de entrada del Worker: API (/api/*) + consumidor de la cola de tareas.
// La interfaz (public/) la sirve Workers Static Assets.

import { Hono } from "hono";
import { listEntries } from "./audit";
import { authRoutes, requireUser } from "./auth";
import { CONNECTORS, connectorRoutes } from "./connectors";
import { redact } from "./crypto";
import { dashboardRoutes } from "./dashboard";
import { type AppEnv, type Env, type RunMessage, publicSettings, settingsFrom } from "./env";
import { processRun } from "./executor";
import { HttpError } from "./http";
import { hubRoutes } from "./hub";
import { chatRoutes } from "./chat";
import { billingRoutes } from "./billing";
import { metricsRoutes } from "./metrics";
import { processAgentRun } from "./agents/runtime";
import { imageRoutes } from "./images";
import { notificationRoutes } from "./notifications";
import { processChatRun } from "./orchestrator/executor";
import { checkRepoLicense } from "./agents/license";
import { getSubscription, PLAN_LIMITS } from "./plans";
import { nowIso, run } from "./db";
import { COLORS, projectRoutes } from "./projects";
import { providerRoutes } from "./providers";
import { runRoutes } from "./runs";
import { RISK_LABELS, TOOLS, toolOut } from "./tools";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const app = new Hono<AppEnv>().basePath("/api");

app.use("*", async (c, next) => {
  c.set("settings", settingsFrom(c.env));
  await next();
  c.header("Content-Security-Policy", CSP);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: redact(err.message) }, err.status as any);
  console.error("Error no controlado", c.req.method, c.req.path, redact(String(err?.stack ?? err)));
  return c.json({ error: "Error interno del servidor. Se ha registrado para revisarlo." }, 500);
});

app.notFound((c) => c.json({ error: "Ruta no encontrada." }, 404));

app.get("/healthz", (c) => c.json({ status: "ok" }));
app.route("/auth", authRoutes);
app.route("/projects", projectRoutes);
app.route("/connectors", connectorRoutes);
app.route("/providers", providerRoutes);
app.route("/dashboard", dashboardRoutes);
app.route("/hub", hubRoutes);
app.route("/chat", chatRoutes);
app.route("/images", imageRoutes);
app.route("/notifications", notificationRoutes);
app.route("/billing", billingRoutes);
app.route("/", metricsRoutes);
app.route("/", runRoutes);

app.get("/activity", requireUser, async (c) => {
  const pid = Number(c.req.query("project_id") || 0) || undefined;
  return c.json(await listEntries(c.env.DB, c.get("user"), (c.req.query("q") || "").trim(), c.req.query("result") || "", pid));
});

// Configuración pública + catálogos. Sin secretos.
app.get("/catalog", requireUser, async (c) => {
  const sub = await getSubscription(c.env.DB, c.get("user").id);
  return c.json({
    plan: sub.plan,
    plan_limits: PLAN_LIMITS[sub.plan],
    settings: publicSettings(c.get("settings")),
    tools: Object.values(TOOLS).map(toolOut),
    risk_labels: RISK_LABELS,
    connector_types: Object.values(CONNECTORS).map((C) => C.type),
    colors: COLORS,
  });
});

/** Update Checker: verifica la licencia de repositorios (solo lee el archivo LICENSE). */
async function checkSources(env: Env, repos: string[]) {
  for (const repo of repos.slice(0, 8)) {
    const r = await checkRepoLicense(repo);
    await run(
      env.DB,
      "UPDATE hub_sources SET license = ?, license_status = ?, license_flags = ?, checked_at = ? WHERE repo = ?",
      r.license,
      r.status,
      r.flags.join(", ") || null,
      nowIso(),
      repo,
    );
  }
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<RunMessage>, env: Env) {
    const settings = settingsFrom(env);
    for (const msg of batch.messages) {
      const body = msg.body;
      try {
        if ("runId" in body) await processRun(env, settings, body.runId);
        else if ("agentRunId" in body) await processAgentRun(env, body.agentRunId);
        else if ("chatRunId" in body) await processChatRun(env, body.chatRunId);
        else if ("sourceCheck" in body) await checkSources(env, body.sourceCheck);
      } catch (err) {
        console.error("Fallo procesando el mensaje de la cola", JSON.stringify(body).slice(0, 200), redact(String(err)));
      }
      msg.ack();
    }
  },
} satisfies ExportedHandler<Env, RunMessage>;
