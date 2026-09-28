// Acceso a D1 con helpers mínimos.

export type Row = Record<string, any>;

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function dumps(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function loads<T = any>(value: string | null | undefined, fallback: T = {} as T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function one<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function all<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

/** Ejecuta una escritura y devuelve el id insertado. */
export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const res = await db.prepare(sql).bind(...params).run();
  return Number(res.meta.last_row_id ?? 0);
}

export async function update(db: D1Database, table: string, id: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db
    .prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), id)
    .run();
}
