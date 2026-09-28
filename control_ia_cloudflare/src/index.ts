// Punto de entrada del Worker: API (/api/*) + consumidor de la cola de tareas.
// La interfaz (public/) la sirve Workers Static Assets.

import { Hono } from "hono";
import { listEntries } from "./audit";
import { authRoutes, requireUser } from "./auth";
import { CONNECTORS, connectorRoutes } from "./connectors";
import { redact } from "./crypto";
import { type AppEnv, type Env, type RunMessage, publicSettings, settingsFrom } from "./env";
import { processRun } from "./executor";
import { HttpError } from "./http";
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
app.route("/", runRoutes);

app.get("/activity", requireUser, async (c) => {
  const pid = Number(c.req.query("project_id") || 0) || undefined;
  return c.json(await listEntries(c.env.DB, c.get("user"), (c.req.query("q") || "").trim(), c.req.query("result") || "", pid));
});

// Configuración pública + catálogos. Sin secretos.
app.get("/catalog", requireUser, (c) =>
  c.json({
    settings: publicSettings(c.get("settings")),
    tools: Object.values(TOOLS).map(toolOut),
    risk_labels: RISK_LABELS,
    connector_types: Object.values(CONNECTORS).map((C) => C.type),
    colors: COLORS,
  }),
);

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<RunMessage>, env: Env) {
    const settings = settingsFrom(env);
    for (const msg of batch.messages) {
      try {
        await processRun(env, settings, msg.body.runId);
      } catch (err) {
        console.error("Fallo procesando la ejecución", msg.body.runId, redact(String(err)));
      }
      msg.ack();
    }
  },
} satisfies ExportedHandler<Env, RunMessage>;
