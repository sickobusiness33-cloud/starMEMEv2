// Seguridad: contraseñas (PBKDF2), tokens, cifrado AES-GCM y redacción de secretos.

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return toB64(arr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- Contraseñas: PBKDF2-SHA256 (100.000 iteraciones es el máximo en Workers) ---

const PBKDF2_ITER = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const computed = await pbkdf2(password, fromB64(salt), Number(iter));
  return safeEqual(toB64(computed), hash);
}

// --- Cifrado de credenciales: AES-GCM con la clave ENCRYPTION_KEY ---

const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("Falta el secreto ENCRYPTION_KEY en el Worker (ver README).");
  let key = keyCache.get(secret);
  if (!key) {
    const raw = fromB64(secret);
    if (raw.length !== 32) throw new Error("ENCRYPTION_KEY debe ser 32 bytes en base64.");
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(secret, key);
  }
  return key;
}

export async function encryptJson(secret: string, value: Record<string, string>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(JSON.stringify(value)));
  return `v1.${toB64(iv)}.${toB64(data)}`;
}

export async function decryptJson(secret: string, blob: string | null | undefined): Promise<Record<string, string>> {
  if (!blob) return {};
  const [v, iv, data] = blob.split(".");
  if (v !== "v1" || !iv || !data) return {};
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await aesKey(secret), fromB64(data));
    const values = JSON.parse(dec.decode(plain)) as Record<string, string>;
    for (const v of Object.values(values)) registerSecret(String(v));
    return values;
  } catch {
    console.error("No se pudieron descifrar credenciales guardadas (¿cambió ENCRYPTION_KEY?).");
    return {};
  }
}

// --- Redacción: ningún secreto en errores, auditoría ni logs ---

const knownSecrets = new Set<string>();

export function registerSecret(value: string) {
  if (value && value.length >= 6) knownSecrets.add(value);
}

const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_\-]{8,}/g, "[secreto oculto]"],
  [/sk-[A-Za-z0-9_\-]{16,}/g, "[secreto oculto]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[secreto oculto]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[secreto oculto]"],
  [/AIza[0-9A-Za-z_\-]{20,}/g, "[secreto oculto]"],
  [/xox[abprs]-[A-Za-z0-9\-]{10,}/g, "[secreto oculto]"],
  [/(discord(?:app)?\.com\/api\/webhooks\/)\d+\/[A-Za-z0-9_\-]+/g, "$1[secreto oculto]"],
  [/(hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g, "$1[secreto oculto]"],
  [/(bearer\s+)[A-Za-z0-9._\-]{12,}/gi, "$1[secreto oculto]"],
];

export function redact(text: unknown): string {
  if (text === null || text === undefined) return "";
  let out = String(text);
  for (const s of [...knownSecrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(s)) out = out.split(s).join("[secreto oculto]");
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
