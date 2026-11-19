// Restablecimiento puntual de una cuenta por el dueño de la plataforma, sin tocar la base de datos a mano.
//
// El secreto ACCOUNT_RESET (`wrangler secret put ACCOUNT_RESET`) contiene JSON:
//   {"email":"…","password_hash":"pbkdf2$…","role":"admin","plan":"pro"}
// Solo viaja el hash de la contraseña (nunca la contraseña). Se aplica UNA vez por valor del secreto
// (marca en ops_applied), así que si después cambias la contraseña desde Ajustes no se vuelve a pisar.

import { record } from "./audit";
import { sha256 } from "./crypto";
import { nowIso, one, run } from "./db";
import type { Env } from "./env";

let done = "";

export async function applyAccountReset(env: Env): Promise<void> {
  const raw = (env as any).ACCOUNT_RESET as string | undefined;
  if (!raw) return;
  const key = `account-reset:${(await sha256(raw)).slice(0, 32)}`;
  if (done === key) return;
  await run(env.DB, "CREATE TABLE IF NOT EXISTS ops_applied (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  if (await one(env.DB, "SELECT 1 FROM ops_applied WHERE key = ?", key)) { done = key; return; }
  let spec: any;
  try { spec = JSON.parse(raw); } catch { console.error("ACCOUNT_RESET no es JSON válido"); return; }
  const email = String(spec?.email ?? "").trim().toLowerCase();
  const hash = String(spec?.password_hash ?? "");
  if (!email || !/^pbkdf2\$\d+\$[^$]+\$[^$]+$/.test(hash)) { console.error("ACCOUNT_RESET incompleto"); return; }
  const user = await one<any>(env.DB, "SELECT id FROM users WHERE email = ?", email);
  if (!user) { console.error("ACCOUNT_RESET: no existe la cuenta"); return; }
  const role = spec.role === "admin" ? "admin" : null;
  await run(env.DB, `UPDATE users SET password_hash = ?${role ? ", role = 'admin'" : ""} WHERE id = ?`, hash, user.id);
  if (spec.plan === "pro") {
    await run(env.DB, "INSERT INTO subscriptions (user_id, plan, subscription_status, provider, updated_at) VALUES (?, 'pro', 'manual', 'manual', ?)" +
      " ON CONFLICT(user_id) DO UPDATE SET plan = 'pro', subscription_status = 'manual', provider = 'manual', renewal_date = NULL, updated_at = excluded.updated_at", user.id, nowIso());
  }
  await run(env.DB, "INSERT OR IGNORE INTO ops_applied (key, applied_at) VALUES (?, ?)", key, nowIso());
  await record(env.DB, { actor: "plataforma", userId: user.id, action: "auth.restablecer_cuenta", detail: `contraseña restablecida${role ? " · admin" : ""}${spec.plan === "pro" ? " · pro" : ""}` });
  done = key;
}
