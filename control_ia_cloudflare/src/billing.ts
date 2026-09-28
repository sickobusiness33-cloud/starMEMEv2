// Suscripciones FREE / PRO.
//
// PaymentProvider es la interfaz de pasarela. Hoy PAYMENT_PROVIDER = "none":
// no se cobra nada y /checkout responde que los pagos aún no están activos.
// StripeProvider está implementado (Checkout + webhook firmado) pero solo se
// activa con PAYMENT_PROVIDER=stripe y los secretos STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET y STRIPE_PRICE_ID. El precio mostrado sale de
// PRO_MONTHLY_PRICE / PRO_CURRENCY (wrangler.jsonc), nunca del frontend.

import { Hono } from "hono";
import { record } from "./audit";
import { requireAdmin, requireUser } from "./auth";
import { safeEqual } from "./crypto";
import { one } from "./db";
import type { AppEnv, Env, User } from "./env";
import { EMAIL, fail, intIn, jsonBody, reqStr } from "./http";
import { notify } from "./notify";
import { getSubscription, PLAN_LIMITS, PRO_FEATURES, priceConfig, setSubscription, usageToday, type PlanId } from "./plans";

export interface PaymentProvider {
  id: string;
  isConfigured(env: Env): boolean;
  createCheckout(env: Env, user: User): Promise<{ url: string }>;
  handleWebhook(env: Env, req: Request): Promise<{ handled: boolean; detail: string }>;
}

class NoPaymentProvider implements PaymentProvider {
  id = "none";
  isConfigured() {
    return false;
  }
  async createCheckout(): Promise<{ url: string }> {
    return fail(503, "Los pagos todavía no están activados. Control IA Pro estará disponible muy pronto.");
  }
  async handleWebhook() {
    return { handled: false, detail: "Sin pasarela de pago" };
  }
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

export class StripeProvider implements PaymentProvider {
  id = "stripe";
  isConfigured(env: Env) {
    return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_ID);
  }

  private async api(env: Env, path: string, form: Record<string, string>) {
    const r = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    const data: any = await r.json();
    if (!r.ok) fail(502, `La pasarela de pago rechazó la petición: ${data?.error?.message ?? r.status}`);
    return data;
  }

  async createCheckout(env: Env, user: User) {
    const base = (env.PUBLIC_URL || "").replace(/\/$/, "");
    const s = await this.api(env, "checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": env.STRIPE_PRICE_ID!,
      "line_items[0][quantity]": "1",
      success_url: `${base}/upgrade?estado=ok`,
      cancel_url: `${base}/upgrade?estado=cancelado`,
      client_reference_id: String(user.id),
      customer_email: user.email,
      "metadata[user_id]": String(user.id),
      "subscription_data[metadata][user_id]": String(user.id),
    });
    return { url: s.url as string };
  }

  async handleWebhook(env: Env, req: Request) {
    const payload = await req.text();
    const header = req.headers.get("Stripe-Signature") || "";
    const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
    const t = Number(parts.t);
    if (!t || Math.abs(Date.now() / 1000 - t) > 300) fail(400, "Firma caducada o ausente.");
    const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET!, `${t}.${payload}`);
    const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
    if (!sigs.some((s) => safeEqual(s, expected))) fail(400, "Firma no válida.");
    const event = JSON.parse(payload);
    const obj = event.data?.object ?? {};
    if (event.type === "checkout.session.completed") {
      const userId = Number(obj.client_reference_id || obj.metadata?.user_id);
      if (!userId) return { handled: false, detail: "Sin usuario" };
      await setSubscription(env.DB, userId, { plan: "pro", status: "active", provider: "stripe", customerId: obj.customer, externalId: obj.subscription });
      await notify(env, userId, { category: "suscripcion", priority: "high", title: "¡Ya eres Control IA Pro!", body: "Agentes premium, más límites y Kairo con hasta 5 agentes por mensaje.", link: "#/upgrade" });
      return { handled: true, detail: `pro activado para ${userId}` };
    }
    if (event.type?.startsWith("customer.subscription.")) {
      let userId = Number(obj.metadata?.user_id);
      if (!userId && obj.customer) userId = (await one<any>(env.DB, "SELECT user_id FROM subscriptions WHERE customer_id = ?", obj.customer))?.user_id;
      if (!userId) return { handled: false, detail: "Sin usuario" };
      const end = obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end;
      const renewal = end ? new Date(end * 1000).toISOString() : null;
      const deleted = event.type === "customer.subscription.deleted";
      const status = deleted ? "canceled" : String(obj.status);
      const plan: PlanId = !deleted && ["active", "trialing"].includes(status) ? "pro" : "free";
      await setSubscription(env.DB, userId, { plan, status, renewal, provider: "stripe", customerId: obj.customer, externalId: obj.id });
      if (plan === "free") await notify(env, userId, { category: "suscripcion", priority: "high", title: "Tu suscripción Pro ha terminado", body: `Estado: ${status}. Sigues teniendo el plan gratuito.`, link: "#/upgrade", dedupe: `sub-${status}` });
      return { handled: true, detail: `${status} para ${userId}` };
    }
    return { handled: false, detail: `Evento ignorado: ${event.type}` };
  }
}

const PROVIDERS: Record<string, PaymentProvider> = { none: new NoPaymentProvider(), stripe: new StripeProvider() };

export function paymentProvider(env: Env): PaymentProvider {
  const p = PROVIDERS[env.PAYMENT_PROVIDER || "none"] ?? PROVIDERS.none;
  return p.isConfigured(env) ? p : PROVIDERS.none;
}

export const billingRoutes = new Hono<AppEnv>();

// Webhook de la pasarela: sin sesión (lo llama la pasarela), verificado por firma.
billingRoutes.post("/webhook/:provider", async (c) => {
  const p = PROVIDERS[c.req.param("provider")];
  if (!p || !p.isConfigured(c.env) || paymentProvider(c.env).id !== p.id) fail(404, "Pasarela no activa.");
  const res = await p.handleWebhook(c.env, c.req.raw);
  await record(c.env.DB, { actor: `pasarela:${p.id}`, action: "billing.webhook", result: res.handled ? "ok" : "ignored", detail: res.detail });
  return c.json({ received: true });
});

billingRoutes.use("*", requireUser);

billingRoutes.get("/plans", async (c) => {
  const user = c.get("user");
  const sub = await getSubscription(c.env.DB, user.id);
  const provider = paymentProvider(c.env);
  return c.json({
    price: priceConfig(c.env),
    payments_enabled: provider.id !== "none",
    payment_provider: provider.id,
    plans: {
      free: { id: "free", limits: PLAN_LIMITS.free },
      pro: { id: "pro", limits: PLAN_LIMITS.pro, features: PRO_FEATURES },
    },
    subscription: sub,
    usage_today: await usageToday(c.env.DB, user.id),
  });
});

billingRoutes.post("/checkout", async (c) => {
  const user = c.get("user");
  const sub = await getSubscription(c.env.DB, user.id);
  if (sub.plan === "pro") fail(409, "Ya tienes Control IA Pro.");
  const res = await paymentProvider(c.env).createCheckout(c.env, user);
  await record(c.env.DB, { actor: user.email, userId: user.id, action: "billing.checkout" });
  return c.json(res);
});

billingRoutes.post("/admin/set-plan", requireAdmin, async (c) => {
  const body = await jsonBody(c.req.raw);
  const email = reqStr(body, "email", { label: "Email", min: 3, max: 200, pattern: EMAIL }).toLowerCase();
  const plan = reqStr(body, "plan", { label: "Plan", min: 3, max: 4, pattern: /^(free|pro)$/ }) as PlanId;
  const months = intIn(body, "months", "Meses", 0, 36, 1);
  const target = await one<any>(c.env.DB, "SELECT id FROM users WHERE lower(email) = ?", email);
  if (!target) fail(404, "No existe ningún usuario con ese email.");
  const renewal = plan === "pro" && months ? new Date(Date.now() + months * 30 * 86_400_000).toISOString() : null;
  await setSubscription(c.env.DB, target.id, { plan, status: plan === "pro" ? "manual" : "none", renewal, provider: "manual" });
  await notify(c.env, target.id, {
    category: "suscripcion",
    priority: "high",
    title: plan === "pro" ? "Tienes Control IA Pro" : "Tu plan ha cambiado a Free",
    body: plan === "pro" ? `Activado por un administrador${renewal ? ` hasta el ${renewal.slice(0, 10)}` : ""}.` : "",
    link: "#/upgrade",
  });
  const u = c.get("user");
  await record(c.env.DB, { actor: u.email, userId: u.id, action: "billing.set_plan", target: email, detail: `${plan} ${months} meses (manual, sin cobro)` });
  return c.json(await getSubscription(c.env.DB, target.id));
});
