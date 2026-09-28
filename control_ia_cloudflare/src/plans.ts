// Planes FREE / PRO: límites y precio en un único sitio.
//
// El precio NO se escribe en el frontend: sale de PRO_MONTHLY_PRICE y
// PRO_CURRENCY (wrangler.jsonc) a través de /api/billing/plans.

import { nowIso, one, run } from "./db";
import type { Env } from "./env";

export type PlanId = "free" | "pro";

export interface PlanLimits {
  chatMessagesPerDay: number;
  agentRunsPerDay: number;
  maxInputChars: number; // límite de contexto por petición
  premiumAgents: boolean; // agentes marcados como premium
  multiAgent: boolean; // flujos multiagente
  claude: boolean; // Claude con los créditos de la plataforma (cuando haya)
  maxOutputTokens: number;
  imagesPerDay: number; // estudio de imágenes (generar, editar, variaciones, upscale)
  maxAgentsPerMessage: number; // agentes que el orquestador puede usar por mensaje
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    chatMessagesPerDay: 40,
    agentRunsPerDay: 15,
    maxInputChars: 4_000,
    premiumAgents: false,
    multiAgent: false,
    claude: false,
    maxOutputTokens: 1_500,
    imagesPerDay: 20,
    maxAgentsPerMessage: 3,
  },
  pro: {
    chatMessagesPerDay: 600,
    agentRunsPerDay: 250,
    maxInputChars: 40_000,
    premiumAgents: true,
    multiAgent: true,
    claude: true,
    maxOutputTokens: 4_000,
    imagesPerDay: 200,
    maxAgentsPerMessage: 5,
  },
};

/** Ventajas de Pro. `status: "coming_soon"` = todavía no existe: se marca así en la UI. */
export const PRO_FEATURES: { id: string; label: string; status: "available" | "coming_soon" }[] = [
  { id: "premium_agents", label: "Acceso a los agentes premium del Agent Hub", status: "available" },
  { id: "claude", label: "Claude como modelo preferente cuando la plataforma tenga créditos", status: "available" },
  { id: "limits", label: "Límites de uso mucho mayores (chat, agentes y contexto)", status: "available" },
  { id: "multi_agent", label: "Flujos multiagente (varios robots colaborando)", status: "available" },
  { id: "orchestrator", label: "Kairo usa hasta 5 agentes por mensaje (Free: 3)", status: "available" },
  { id: "images", label: "200 imágenes al día en el estudio (Free: 20)", status: "available" },
  { id: "advanced", label: "Análisis avanzado: investigación profunda, estrategia, código", status: "available" },
  { id: "priority", label: "Prioridad de ejecución en la cola", status: "coming_soon" },
  { id: "hub_advanced", label: "Agentes personalizados y funciones avanzadas del Agent Hub", status: "coming_soon" },
];

export function priceConfig(env: Env) {
  const amount = Number(env.PRO_MONTHLY_PRICE);
  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : 20,
    currency: (env.PRO_CURRENCY || "EUR").toUpperCase(),
    interval: "month" as const,
  };
}

export interface Subscription {
  plan: PlanId;
  subscription_status: string;
  renewal_date: string | null;
  provider: string | null;
  customer_id: string | null;
}

/** Plan efectivo del usuario. Pro solo cuenta si la suscripción está vigente. */
export async function getSubscription(db: D1Database, userId: number): Promise<Subscription> {
  const row = await one<any>(db, "SELECT * FROM subscriptions WHERE user_id = ?", userId);
  if (!row) return { plan: "free", subscription_status: "none", renewal_date: null, provider: null, customer_id: null };
  const activeStatus = ["active", "trialing", "manual"].includes(row.subscription_status);
  const notExpired = !row.renewal_date || new Date(row.renewal_date).getTime() > Date.now();
  const plan: PlanId = row.plan === "pro" && activeStatus && notExpired ? "pro" : "free";
  return {
    plan,
    subscription_status: row.subscription_status,
    renewal_date: row.renewal_date,
    provider: row.provider,
    customer_id: row.customer_id,
  };
}

export async function setSubscription(
  db: D1Database,
  userId: number,
  s: { plan: PlanId; status: string; renewal?: string | null; provider: string; customerId?: string | null; externalId?: string | null },
) {
  await run(
    db,
    "INSERT INTO subscriptions (user_id, plan, subscription_status, renewal_date, provider, customer_id, external_subscription_id, updated_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, subscription_status = excluded.subscription_status," +
      " renewal_date = excluded.renewal_date, provider = excluded.provider, customer_id = COALESCE(excluded.customer_id, subscriptions.customer_id)," +
      " external_subscription_id = COALESCE(excluded.external_subscription_id, subscriptions.external_subscription_id), updated_at = excluded.updated_at",
    userId,
    s.plan,
    s.status,
    s.renewal ?? null,
    s.provider,
    s.customerId ?? null,
    s.externalId ?? null,
    nowIso(),
  );
}

/** Uso de hoy (UTC) para aplicar los límites diarios. */
export async function usageToday(db: D1Database, userId: number) {
  const today = new Date().toISOString().slice(0, 10);
  const chat = await one<any>(
    db,
    "SELECT COUNT(*) AS n FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE t.user_id = ? AND m.role = 'user' AND m.created_at >= ?",
    userId,
    today,
  );
  const agents = await one<any>(db, "SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ? AND created_at >= ?", userId, today);
  const images = await one<any>(db, "SELECT COUNT(*) AS n FROM images WHERE user_id = ? AND mode NOT IN ('upload', 'upscale') AND created_at >= ?", userId, today);
  return { chat: chat?.n ?? 0, agents: agents?.n ?? 0, images: images?.n ?? 0 };
}
