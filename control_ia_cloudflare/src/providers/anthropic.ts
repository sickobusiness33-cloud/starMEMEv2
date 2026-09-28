// Proveedor Anthropic (Claude) con el SDK oficial @anthropic-ai/sdk.

import Anthropic from "@anthropic-ai/sdk";
import { redact } from "../crypto";
import { MAX_TOKENS, type ParamSpec, Provider, ProviderError, type StepArgs, type StepResult, type ToolOutcome } from "./base";

// sampling: acepta temperature (los modelos nuevos la rechazan con 400).
// effort: acepta output_config.effort.
export const CLAUDE_MODELS: Record<string, { sampling: boolean; effort: boolean }> = {
  "claude-opus-5": { sampling: false, effort: true },
  "claude-opus-5-5": { sampling: false, effort: true },
  "claude-fable-5-1": { sampling: false, effort: true },
  "claude-sonnet-5": { sampling: false, effort: true },
  "claude-opus-4-8": { sampling: false, effort: true },
  "claude-opus-4-7": { sampling: false, effort: true },
  "claude-opus-4-6": { sampling: true, effort: true },
  "claude-sonnet-4-6": { sampling: true, effort: true },
  "claude-haiku-4-5": { sampling: true, effort: false },
};
const EFFORT = ["low", "medium", "high", "xhigh", "max"];

// Modelo desconocido: no se envían parámetros opcionales para evitar errores 400.
const caps = (model: string) => CLAUDE_MODELS[model] ?? { sampling: false, effort: false };

function mapError(err: unknown, model: string): ProviderError {
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError("Anthropic rechazó tu API key (401): no es válida o fue revocada.");
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError("Tu API key de Anthropic no tiene permiso para esta operación (403).");
  if (err instanceof Anthropic.NotFoundError) return new ProviderError(`El modelo '${model}' no existe o tu cuenta no tiene acceso (404).`);
  if (err instanceof Anthropic.RateLimitError) return new ProviderError("Límite de uso de Anthropic alcanzado (429). Reintenta en unos minutos.", true);
  if (err instanceof Anthropic.BadRequestError) return new ProviderError(`Anthropic rechazó la petición (400): ${redact(err.message)}`);
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError("Llamada cancelada.");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("Anthropic no respondió a tiempo. Reintenta la tarea.", true);
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError("No se pudo conectar con Anthropic.", true);
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    return new ProviderError(`Error del servidor de Anthropic (${status}). Reintenta más tarde.`, status >= 500);
  }
  return new ProviderError(`Error inesperado llamando a Anthropic: ${redact(err)}`);
}

export class AnthropicProvider extends Provider {
  id = "anthropic";
  name = "Anthropic (Claude)";
  description = "Modelos Claude con tu propia API key. Puede trabajar sobre tu repositorio de GitHub con herramientas.";
  keyHelp = "Crea una API key en console.anthropic.com → API Keys y pégala aquí.";

  private client() {
    this.ensureConfigured();
    return new Anthropic({
      apiKey: this.apiKey,
      timeout: this.settings.providerTimeoutSeconds * 1000,
      maxRetries: this.settings.providerMaxRetries,
    });
  }

  suggestedModels() {
    return Object.keys(CLAUDE_MODELS);
  }

  async listModels() {
    try {
      const page = await this.client().models.list({ limit: 100 });
      return page.data.map((m) => m.id);
    } catch (err) {
      throw mapError(err, "");
    }
  }

  paramsFor(model: string): ParamSpec[] {
    const c = caps(model);
    const specs: ParamSpec[] = [MAX_TOKENS];
    if (c.effort) specs.push({ name: "effort", label: "Esfuerzo", type: "choice", choices: EFFORT, help: "Profundidad de razonamiento y gasto de tokens." });
    if (c.sampling) specs.push({ name: "temperature", label: "Temperatura", type: "float", min: 0, max: 1, help: "Aleatoriedad (0 = más determinista)." });
    return specs;
  }

  async test() {
    const models = await this.listModels();
    return `Conexión correcta. ${models.length} modelos disponibles con tu API key.`;
  }

  async step({ model, system, transcript, tools, params, signal }: StepArgs): Promise<StepResult> {
    const client = this.client();
    const body: Record<string, any> = {
      model,
      max_tokens: Number(params.max_tokens ?? 4096),
      system,
      messages: transcript,
    };
    if (params.effort) body.output_config = { effort: params.effort };
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (tools.length) body.tools = tools;
    let message: Anthropic.Message;
    try {
      // Streaming + finalMessage evita timeouts HTTP con max_tokens altos.
      message = await client.messages.stream(body as any, { signal }).finalMessage();
    } catch (err) {
      throw mapError(err, model);
    }
    if (message.stop_reason === "refusal") throw new ProviderError("El modelo declinó responder a esta petición.");
    const text = message.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    const toolCalls = message.content
      .filter((b) => b.type === "tool_use")
      .map((b: any) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
    let finalText = text;
    if (message.stop_reason === "max_tokens" && !toolCalls.length) {
      finalText += "\n\n[Respuesta cortada: se alcanzó el límite de tokens configurado.]";
    }
    return {
      text: finalText,
      toolCalls,
      assistantMessages: [{ role: "assistant", content: message.content }],
      usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
      stopReason: message.stop_reason ?? "",
    };
  }

  toolResultsMessages(outcomes: ToolOutcome[]) {
    // Todas las respuestas de herramientas en un único mensaje de usuario.
    return [
      {
        role: "user",
        content: outcomes.map((o) => ({ type: "tool_result", tool_use_id: o.call.id, content: o.content, is_error: o.isError })),
      },
    ];
  }
}
