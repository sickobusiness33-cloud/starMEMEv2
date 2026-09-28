// Errores HTTP con mensaje para el usuario y validación de entradas.

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

type Body = Record<string, unknown>;

interface StrOpts {
  label: string;
  min?: number;
  max: number;
  pattern?: RegExp;
  optional?: boolean;
  trim?: boolean;
}

/** Lee un texto validado del cuerpo. Con optional=true devuelve undefined si no viene. */
export function str(body: Body, key: string, o: StrOpts): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) {
    if (o.optional) return undefined;
    return fail(422, `Falta «${o.label}».`);
  }
  if (typeof raw !== "string") return fail(422, `«${o.label}» debe ser texto.`);
  const value = o.trim === false ? raw : raw.trim();
  if (o.min !== undefined && value.length < o.min) {
    return fail(422, o.min <= 1 ? `«${o.label}» es obligatorio.` : `«${o.label}» es demasiado corto (mín. ${o.min}).`);
  }
  if (value.length > o.max) return fail(422, `«${o.label}» es demasiado largo (máx. ${o.max}).`);
  if (o.pattern && value && !o.pattern.test(value)) return fail(422, `«${o.label}» no tiene un formato válido.`);
  return value;
}

export function reqStr(body: Body, key: string, o: StrOpts): string {
  return str(body, key, { ...o, optional: false }) as string;
}

export function intIn(body: Body, key: string, label: string, min: number, max: number, def?: number): number {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === "") {
    if (def !== undefined) return def;
    return fail(422, `Falta «${label}».`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fail(422, `«${label}» debe estar entre ${min} y ${max}.`);
  return n;
}

export function boolOf(body: Body, key: string): boolean {
  const v = body[key];
  if (typeof v !== "boolean") return fail(422, `«${key}» debe ser verdadero o falso.`);
  return v;
}

export function objOf(body: Body, key: string): Record<string, unknown> {
  const v = body[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return fail(422, `«${key}» debe ser un objeto.`);
  return v as Record<string, unknown>;
}

export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function jsonBody(req: Request): Promise<Body> {
  try {
    const data = await req.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return fail(422, "El cuerpo debe ser un objeto JSON.");
    return data as Body;
  } catch {
    return fail(400, "JSON no válido.");
  }
}

export const toId = (v: string | undefined): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return fail(404, "No encontrado.");
  return n;
};
