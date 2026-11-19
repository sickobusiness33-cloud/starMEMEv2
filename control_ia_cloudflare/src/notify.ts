// Creación de notificaciones (sin dependencias de auth para evitar ciclos de importación).
//
// Categorías, prioridad, preferencias por categoría y antispam
// (deduplicación + tope por hora). Las rutas están en notifications.ts.

import { nowIso, one, run } from "./db";
import type { Env } from "./env";

export const CATEGORIES = {
  ia: { label: "IA", icon: "spark" },
  sistema: { label: "Sistema", icon: "cpu" },
  seguridad: { label: "Seguridad", icon: "shield" },
  cuenta: { label: "Cuenta", icon: "user" },
  suscripcion: { label: "Suscripción", icon: "star" },
  alertas: { label: "Alertas", icon: "bell" },
} as const;
export type Category = keyof typeof CATEGORIES;

const MAX_PER_HOUR = 20;
const DEDUPE_MINUTES = 10;

export interface NotifyInput {
  category: Category;
  priority?: "low" | "normal" | "high";
  title: string;
  body?: string;
  link?: string;
  /** Misma clave en los últimos minutos y sin leer = no se repite. */
  dedupe?: string;
}

/** Crea una notificación si las preferencias lo permiten y no es spam. Nunca lanza. */
export async function notify(env: Env, userId: number, n: NotifyInput): Promise<number | null> {
  try {
    const pref = await one<any>(env.DB, "SELECT in_app FROM notification_prefs WHERE user_id = ? AND category = ?", userId, n.category);
    // Seguridad no se puede silenciar.
    if (pref && !pref.in_app && n.category !== "seguridad") return null;
    const since = new Date(Date.now() - DEDUPE_MINUTES * 60_000).toISOString();
    if (n.dedupe) {
      const dup = await one<any>(env.DB, "SELECT id FROM notifications WHERE user_id = ? AND dedupe_key = ? AND read_at IS NULL AND created_at >= ?", userId, n.dedupe, since);
      if (dup) return null;
    }
    const hour = new Date(Date.now() - 3600_000).toISOString();
    const count = await one<any>(env.DB, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND created_at >= ?", userId, hour);
    if ((count?.n ?? 0) >= MAX_PER_HOUR && n.priority !== "high") return null;
    return await run(
      env.DB,
      "INSERT INTO notifications (user_id, category, priority, title, body, link, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      userId,
      n.category,
      n.priority ?? "normal",
      n.title.slice(0, 120),
      (n.body ?? "").slice(0, 400),
      n.link ?? null,
      n.dedupe ?? null,
      nowIso(),
    );
  } catch (err) {
    console.error("No se pudo crear la notificación", String(err));
    return null;
  }
}

