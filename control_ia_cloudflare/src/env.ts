// Tipos del entorno del Worker y configuración derivada.
//
// Separación pública/secreta:
// - `vars` en wrangler.jsonc: configuración pública (se puede mostrar en la UI).
// - Secretos (`wrangler secret put`): ENCRYPTION_KEY. Nunca salen del Worker.

/** Mensajes de la cola: tareas de proyecto, ejecuciones de agentes o verificación de fuentes. */
export type RunMessage = { runId: number } | { agentRunId: number } | { chatRunId: number } | { sourceCheck: string[] } | { firebaseSync: { kind: "user" | "project" | "run" | "thread"; ids: number[] } } | { apCycle: number } | { apTask: number };

export interface Env {
  DB: D1Database;
  RUNS: Queue<RunMessage>;
  ASSETS: Fetcher;
  // Secreto: 32 bytes en base64 para AES-GCM (credenciales cifradas).
  ENCRYPTION_KEY: string;
  ALLOW_SIGNUP: string;
  ADMIN_EMAILS: string;
  COOKIE_SECURE: string;
  SESSION_HOURS: string;
  RUNS_PER_MINUTE: string;
  SIGNUPS_PER_HOUR_PER_IP: string;
  LOGIN_ATTEMPTS_PER_MINUTE: string;
  PROVIDER_TIMEOUT_SECONDS: string;
  PROVIDER_MAX_RETRIES: string;
  MAX_FILE_BYTES: string;
  ENABLE_DEMO_PROVIDER: string;
  OPENAI_BASE_URL: string;
  // --- Plataforma de IA ---
  AI?: Ai; // Cloudflare Workers AI (modelos gratuitos)
  ANTHROPIC_API_KEY?: string; // SECRETO: créditos Claude de la plataforma (Pro)
  ANTHROPIC_BASE_URL?: string; // solo para pruebas locales
  AI_MODE?: string; // "mock" solo en tests locales; en producción no se define
  FREE_MODEL: string;
  FREE_MODEL_FALLBACK: string;
  IMAGE_MODEL: string;
  CLAUDE_MODEL: string;
  CLAUDE_MODEL_ADVANCED: string;
  // --- Suscripción ---
  PRO_MONTHLY_PRICE: string;
  PRO_CURRENCY: string;
  PAYMENT_PROVIDER: string; // none | stripe
  STRIPE_SECRET_KEY?: string; // SECRETO
  STRIPE_WEBHOOK_SECRET?: string; // SECRETO
  STRIPE_PRICE_ID?: string;
  PUBLIC_URL?: string;
  // --- Firebase (copia de datos en Firestore) ---
  FIREBASE_SERVICE_ACCOUNT?: string; // SECRETO: JSON de la cuenta de servicio
}

export interface Settings {
  allowSignup: boolean;
  adminEmails: string[];
  cookieSecure: boolean;
  sessionHours: number;
  runsPerMinute: number;
  signupsPerHourPerIp: number;
  loginAttemptsPerMinute: number;
  providerTimeoutSeconds: number;
  providerMaxRetries: number;
  maxFileBytes: number;
  enableDemoProvider: boolean;
  openaiBaseUrl: string;
}

const bool = (v: string | undefined, d: boolean) =>
  v === undefined ? d : ["1", "true", "yes", "si", "sí"].includes(v.trim().toLowerCase());
const int = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function settingsFrom(env: Env): Settings {
  return {
    allowSignup: bool(env.ALLOW_SIGNUP, true),
    adminEmails: (env.ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    cookieSecure: bool(env.COOKIE_SECURE, true),
    sessionHours: int(env.SESSION_HOURS, 72),
    runsPerMinute: int(env.RUNS_PER_MINUTE, 10),
    signupsPerHourPerIp: int(env.SIGNUPS_PER_HOUR_PER_IP, 5),
    loginAttemptsPerMinute: int(env.LOGIN_ATTEMPTS_PER_MINUTE, 5),
    providerTimeoutSeconds: int(env.PROVIDER_TIMEOUT_SECONDS, 300),
    providerMaxRetries: int(env.PROVIDER_MAX_RETRIES, 2),
    maxFileBytes: int(env.MAX_FILE_BYTES, 256 * 1024),
    enableDemoProvider: bool(env.ENABLE_DEMO_PROVIDER, true),
    openaiBaseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  };
}

export function publicSettings(s: Settings) {
  return {
    allow_signup: s.allowSignup,
    runs_per_minute_per_user: s.runsPerMinute,
    provider_timeout_seconds: s.providerTimeoutSeconds,
    provider_max_retries: s.providerMaxRetries,
    max_file_bytes: s.maxFileBytes,
    session_hours: s.sessionHours,
    enable_demo_provider: s.enableDemoProvider,
    cookie_secure: s.cookieSecure,
    max_concurrent_runs: 5,
  };
}

export interface User {
  id: number;
  email: string;
  name: string;
  role: "admin" | "member";
  created_at: string;
  password_hash: string;
  csrf_token?: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: User; settings: Settings } };
