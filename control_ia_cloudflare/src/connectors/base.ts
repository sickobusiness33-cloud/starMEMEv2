// Interfaz común de conectores. Cada uno declara campos (públicos o secretos),
// permisos que necesita, pasos para obtener credenciales y una prueba REAL.

import { redact } from "../crypto";

export class ConnectorError extends Error {
  constructor(message: string) {
    super(redact(message));
  }
}

export interface FieldSpec {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  pattern?: string;
}

export interface ConnectorType {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  setup_steps: string[];
  fields: FieldSpec[];
}

export abstract class Connector {
  static type: ConnectorType;

  constructor(public config: Record<string, string>, public secrets: Record<string, string>) {}

  get type(): ConnectorType {
    return (this.constructor as typeof Connector).type;
  }

  missingFields(): string[] {
    return this.type.fields
      .filter((f) => f.required !== false && !((f.secret ? this.secrets : this.config)[f.name] ?? "").trim())
      .map((f) => f.label);
  }

  abstract test(): Promise<string>;

  protected async http(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (err: any) {
      if (err?.name === "TimeoutError") throw new ConnectorError(`${this.type.name} no respondió a tiempo.`);
      throw new ConnectorError(`No se pudo conectar con ${this.type.name}.`);
    }
  }
}

export function validateFields(type: ConnectorType, config: Record<string, string>, secrets: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const f of type.fields) {
    const v = ((f.secret ? secrets : config)[f.name] ?? "").trim();
    if (v && f.pattern && !new RegExp(`^(?:${f.pattern})$`).test(v)) errors.push(`${f.label}: formato no válido.`);
  }
  return errors;
}
