// Interfaz común de proveedores de IA. La transcripción se guarda en el
// formato nativo de cada proveedor para poder continuar tras una confirmación.

import type { Settings } from "../env";

export class ProviderError extends Error {
  constructor(message: string, public retryable = false) {
    super(message);
  }
}

export class ProviderNotConfigured extends ProviderError {}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolOutcome {
  call: ToolCall;
  content: string;
  isError: boolean;
}

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  assistantMessages: any[];
  usage: Record<string, number>;
  stopReason: string;
}

export interface ParamSpec {
  name: string;
  label: string;
  type: "int" | "float" | "choice";
  default?: number | string;
  min?: number;
  max?: number;
  choices?: string[];
  help?: string;
}

export const MAX_TOKENS: ParamSpec = {
  name: "max_tokens",
  label: "Máx. tokens de respuesta",
  type: "int",
  default: 4096,
  min: 1,
  max: 64000,
  help: "Tope de tokens que puede generar cada paso. Limita coste y longitud.",
};

export interface StepArgs {
  model: string;
  system: string;
  transcript: any[];
  tools: ToolDef[];
  params: Record<string, any>;
  signal: AbortSignal;
}

export abstract class Provider {
  abstract id: string;
  abstract name: string;
  abstract description: string;
  requiresKey = true;
  keyHelp = "";
  isDemo = false;

  constructor(protected settings: Settings, protected apiKey = "") {}

  configurationProblem(): string | null {
    if (this.requiresKey && !this.apiKey) {
      return `No has conectado tu clave de ${this.name}. Añádela en Configuración → Mis IAs.`;
    }
    return null;
  }

  ensureConfigured() {
    const p = this.configurationProblem();
    if (p) throw new ProviderNotConfigured(p);
  }

  abstract suggestedModels(): string[];

  async listModels(): Promise<string[]> {
    return this.suggestedModels();
  }

  paramsFor(_model: string): ParamSpec[] {
    return [MAX_TOKENS];
  }

  /** Descarta parámetros no compatibles con el modelo y valida rangos. */
  cleanParams(model: string, params: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const spec of this.paramsFor(model)) {
      const value = params[spec.name];
      if (value === undefined || value === null || value === "") {
        if (spec.default !== undefined) out[spec.name] = spec.default;
        continue;
      }
      if (spec.type === "choice") {
        if (!spec.choices?.includes(String(value))) throw new ProviderError(`Valor no válido para ${spec.label}: ${value}`);
        out[spec.name] = String(value);
        continue;
      }
      const num = Number(value);
      if (!Number.isFinite(num) || (spec.type === "int" && !Number.isInteger(num))) {
        throw new ProviderError(`${spec.label} debe ser un número.`);
      }
      if ((spec.min !== undefined && num < spec.min) || (spec.max !== undefined && num > spec.max)) {
        throw new ProviderError(`${spec.label} debe estar entre ${spec.min} y ${spec.max}.`);
      }
      out[spec.name] = num;
    }
    return out;
  }

  abstract test(): Promise<string>;

  historyMessages(history: [string, string][]): any[] {
    return history.map(([role, content]) => ({ role, content }));
  }

  abstract step(args: StepArgs): Promise<StepResult>;

  abstract toolResultsMessages(outcomes: ToolOutcome[]): any[];
}
