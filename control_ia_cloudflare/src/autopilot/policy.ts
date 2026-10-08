// Política de riesgo del Autopilot.
//
//   LOW       → se ejecuta sola.
//   MEDIUM    → se ejecuta sola, queda registrada y la revisa el Reviewer.
//   HIGH      → la tarea se aparca en NEEDS_APPROVAL hasta que el administrador la apruebe.
//   CRITICAL  → bloqueada siempre. No existe ninguna herramienta que la ejecute.
//
// El agente NO decide el riesgo de una acción: el riesgo de cada herramienta es fijo y,
// además, el texto de la tarea se clasifica por palabras clave. Se aplica el máximo.

export type Risk = "low" | "medium" | "high" | "critical";
export const RISK_ORDER: Risk[] = ["low", "medium", "high", "critical"];
export const maxRisk = (...r: Risk[]): Risk => RISK_ORDER[Math.max(...r.map((x) => RISK_ORDER.indexOf(x)))];

export type ApToolId =
  | "repo.list_files" | "repo.read_file" | "repo.list_issues" | "repo.ci_status"
  | "repo.create_issue" | "repo.propose_pr"
  | "web.read" | "memory.write" | "system.health";

export const TOOL_RISK: Record<ApToolId, Risk> = {
  "repo.list_files": "low",
  "repo.read_file": "low",
  "repo.list_issues": "low",
  "repo.ci_status": "low",
  "web.read": "low",
  "memory.write": "low",
  "system.health": "low",
  "repo.create_issue": "medium",
  "repo.propose_pr": "high",
};

// Temas que NUNCA ejecuta un agente: credenciales, dinero, producción, borrado irreversible.
const CRITICAL = [
  /\b(private[_ ]?key|clave privada|seed phrase|mnemonic|frase semilla)\b/i,
  /\b(wallet|cartera|monedero)\b.*\b(transfer|envi|mueve|firma|sign|drena)/i,
  /\b(transfer(ir|encia)?|withdraw|retir(ar|o)) (de )?(fondos|funds|dinero|money|tokens?)\b/i,
  /\b(drop (table|database)|truncate table|rm -rf|borra(r)? (toda|todos|la base|los datos|usuarios)|delete (all|every|the database|users))\b/i,
  /\b(deploy|despliega|desplegar|publicar|merge|fusiona|fusionar)\b.*\b(producci[oó]n|production|main|master)\b/i,
  /\b(api[_ -]?key|secret|secreto|token de acceso|password|contraseñas?)\b.*\b(cambia|rota|mostrar|muestra|exporta|revela|print|leak|envía)/i,
];
// Temas sensibles: se permiten, pero siempre con aprobación humana.
const HIGH = [
  /\b(pago|payment|stripe|factura|billing|suscripci[oó]n|plan pro)\b/i,
  /\b(auth|autenticaci[oó]n|login|sesi[oó]n|cookie|csrf|permisos|roles?)\b/i,
  /\b(migraci[oó]n|migration|schema|esquema|alter table)\b/i,
  /\b(cifrado|encrypt|crypto|secreto|secret|credencial)/i,
  /\b(wallet|cartera|blockchain|smart contract)\b/i,
  /\b(elimina|borrar|delete|remove)\b/i,
];

export function classifyText(text: string): Risk {
  if (CRITICAL.some((re) => re.test(text))) return "critical";
  if (HIGH.some((re) => re.test(text))) return "high";
  return "low";
}

/** Rutas que un agente nunca puede escribir (aunque apruebes el PR se rechazan). */
const FORBIDDEN_PATHS = [/^\.github\/workflows\//, /(^|\/)\.env/, /(^|\/)\.dev\.vars/, /wrangler\.(toml|jsonc?)$/, /(^|\/)(secrets?|credentials?)\b/i, /\.(pem|key|p12)$/i];
export function forbiddenPath(path: string): boolean {
  return FORBIDDEN_PATHS.some((re) => re.test(path));
}

/** Detecta contenido que parece un secreto dentro de un cambio propuesto. */
export function looksLikeSecret(text: string): boolean {
  return /(sk-ant-api\d\d-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|cfut_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})/.test(text);
}
