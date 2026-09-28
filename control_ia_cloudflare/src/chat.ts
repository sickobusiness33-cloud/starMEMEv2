// AI CHAT central: conversa con Claude, con los modelos gratuitos de Cloudflare
// o con la personalidad de un agente del Hub. Todo pasa por el AI Router.
//
// Modos: auto (Claude si está disponible, si no gratuito) · claude (solo Claude)
//        · free (solo modelos gratuitos) · agent:<id> (instrucciones del agente)

import { Hono, type Context } from "hono";
import { requireUser } from "./auth";
import { all, nowIso, one, run } from "./db";
import type { AppEnv } from "./env";
import { fail, jsonBody, reqStr, str, toId } from "./http";
import { getSubscription, PLAN_LIMITS, usageToday } from "./plans";
import { hit } from "./ratelimit";
import { generate, RouterError } from "./ai/router";
import { getAgent } from "./agents/registry";

export const chatRoutes = new Hono<AppEnv>();
chatRoutes.use("*", requireUser);

const SYSTEM =
  "Eres el asistente del chat de Control IA, un centro de control de agentes de IA. Responde en el idioma del usuario, " +
  "de forma clara y útil, con formato Markdown sencillo cuando ayude. No inventes datos ni fuentes: si no lo sabes, dilo. " +
  "No puedes ejecutar acciones externas desde este chat; para tareas de varios pasos el usuario puede usar los agentes del Agent Hub.";

const MODE = /^(auto|claude|free|agent:[a-z0-9][a-z0-9-]{1,59})$/;
const HISTORY = 12;

async function ownThread(c: Context<AppEnv>) {
  const row = await one<any>(c.env.DB, "SELECT * FROM chat_threads WHERE id = ? AND user_id = ?", toId(c.req.param("id")), c.get("user").id);
  if (!row) fail(404, "Conversación no encontrada.");
  return row;
}

chatRoutes.get("/threads", async (c) =>
  c.json(await all(c.env.DB, "SELECT * FROM chat_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50", c.get("user").id)),
);

chatRoutes.post("/threads", async (c) => {
  const body = await jsonBody(c.req.raw);
  const mode = str(body, "mode", { label: "Modo", max: 70, pattern: MODE, optional: true }) ?? "auto";
  const title = str(body, "title", { label: "Título", max: 80, optional: true }) || "Nueva conversación";
  const now = nowIso();
  const id = await run(c.env.DB, "INSERT INTO chat_threads (user_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", c.get("user").id, title, mode, now, now);
  return c.json(await one(c.env.DB, "SELECT * FROM chat_threads WHERE id = ?", id), 201);
});

chatRoutes.get("/threads/:id", async (c) => {
  const t = await ownThread(c);
  const messages = await all(c.env.DB, "SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 200", t.id);
  return c.json({ ...t, messages: messages.reverse() });
});

chatRoutes.patch("/threads/:id", async (c) => {
  const t = await ownThread(c);
  const body = await jsonBody(c.req.raw);
  const mode = str(body, "mode", { label: "Modo", max: 70, pattern: MODE, optional: true }) ?? t.mode;
  const title = str(body, "title", { label: "Título", min: 1, max: 80, optional: true }) ?? t.title;
  await run(c.env.DB, "UPDATE chat_threads SET mode = ?, title = ?, updated_at = ? WHERE id = ?", mode, title, nowIso(), t.id);
  return c.json(await one(c.env.DB, "SELECT * FROM chat_threads WHERE id = ?", t.id));
});

chatRoutes.delete("/threads/:id", async (c) => {
  const t = await ownThread(c);
  await run(c.env.DB, "DELETE FROM chat_threads WHERE id = ?", t.id);
  return c.json({ ok: true });
});

chatRoutes.post("/threads/:id/messages", async (c) => {
  const user = c.get("user");
  const t = await ownThread(c);
  const body = await jsonBody(c.req.raw);
  const mode = str(body, "mode", { label: "Modo", max: 70, pattern: MODE, optional: true }) ?? t.mode;
  const sub = await getSubscription(c.env.DB, user.id);
  const limits = PLAN_LIMITS[sub.plan];
  const content = reqStr(body, "content", { label: "Mensaje", min: 1, max: 40_000 });
  if (content.length > limits.maxInputChars) fail(413, `Tu plan permite mensajes de hasta ${limits.maxInputChars.toLocaleString("es-ES")} caracteres.`);
  const used = await usageToday(c.env.DB, user.id);
  if (used.chat >= limits.chatMessagesPerDay) {
    fail(429, `Has usado los ${limits.chatMessagesPerDay} mensajes de chat de hoy.${sub.plan === "free" ? " Pro amplía el límite." : ""}`);
  }
  const wait = await hit(c.env.DB, `chat:${user.id}`, 20, 60);
  if (wait) fail(429, `Vas muy rápido. Espera ${wait} s.`);

  let system = SYSTEM;
  let agentId: string | null = null;
  let prefer: "premium" | "free" = "premium";
  let allowFallback = true;
  let advanced = false;
  if (mode === "free") prefer = "free";
  if (mode === "claude") allowFallback = false;
  if (mode.startsWith("agent:")) {
    const a = await getAgent(c.env.DB, mode.slice(6));
    if (!a) fail(404, "Ese agente ya no está en el Hub.");
    if (a!.tier === "pro" && !limits.premiumAgents) fail(402, `«${a!.name}» es un agente premium: requiere Control IA Pro.`);
    system = `${a!.instructions}\n\nEstás conversando en el chat de Control IA como el agente «${a!.name}».`;
    agentId = a!.id;
    prefer = a!.model.prefer;
    allowFallback = a!.model.allowFallback;
    advanced = Boolean(a!.model.advanced);
  }

  const now = nowIso();
  await run(c.env.DB, "INSERT INTO chat_messages (thread_id, role, content, agent_id, created_at) VALUES (?, 'user', ?, ?, ?)", t.id, content, agentId, now);
  const history = (await all<any>(c.env.DB, "SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?", t.id, HISTORY)).reverse();
  // El historial también respeta el límite de contexto del plan.
  let budget = limits.maxInputChars * 3;
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    budget -= history[i].content.length;
    if (budget < 0 && messages.length) break;
    messages.unshift({ role: history[i].role, content: history[i].content });
  }
  while (messages.length && messages[0].role !== "user") messages.shift();

  const title = t.title === "Nueva conversación" ? content.replace(/\s+/g, " ").slice(0, 60) : t.title;
  await run(c.env.DB, "UPDATE chat_threads SET mode = ?, title = ?, updated_at = ? WHERE id = ?", mode, title, now, t.id);
  try {
    const res = await generate(
      { env: c.env, userId: user.id, plan: sub.plan, kind: "chat", agentId },
      { system, messages, maxTokens: limits.maxOutputTokens, prefer, allowFallback, advanced },
    );
    const notice = res.notices.join(" · ") || null;
    const mid = await run(
      c.env.DB,
      "INSERT INTO chat_messages (thread_id, role, content, provider, model, fallback, notice, agent_id, created_at) VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?)",
      t.id,
      res.text,
      res.provider,
      res.model,
      res.fallback ? 1 : 0,
      notice,
      agentId,
      nowIso(),
    );
    return c.json({ message: await one(c.env.DB, "SELECT * FROM chat_messages WHERE id = ?", mid), latency_ms: res.latencyMs }, 201);
  } catch (err) {
    if (err instanceof RouterError) fail(err.code === "premium_unavailable" ? 409 : 502, err.message);
    throw err;
  }
});
