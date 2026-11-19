// Límite de ventana deslizante guardado en D1 (los isolates de Workers no comparten memoria).

import { one, run } from "./db";

/** Registra un evento. Devuelve 0 si se permite o los segundos que hay que esperar. */
export async function hit(db: D1Database, key: string, max: number, windowSeconds: number): Promise<number> {
  const now = Date.now();
  const since = now - windowSeconds * 1000;
  const row = await one<{ n: number; oldest: number | null }>(
    db,
    "SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM rate_events WHERE key = ? AND ts > ?",
    key,
    since,
  );
  if (row && row.n >= max) {
    return Math.max(1, Math.ceil(((row.oldest ?? now) + windowSeconds * 1000 - now) / 1000));
  }
  await run(db, "INSERT INTO rate_events (key, ts) VALUES (?, ?)", key, now);
  // Limpieza oportunista de eventos antiguos (más de un día).
  if (Math.random() < 0.05) await run(db, "DELETE FROM rate_events WHERE ts < ?", now - 86_400_000);
  return 0;
}

export async function reset(db: D1Database, key: string) {
  await run(db, "DELETE FROM rate_events WHERE key = ?", key);
}
