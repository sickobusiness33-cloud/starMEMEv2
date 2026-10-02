// Proveedor OpenAI (o API compatible) por HTTP.

import { redact } from "../crypto";
import { type Attachment, MAX_TOKENS, type ParamSpec, wrapUntrusted, Provider, ProviderError, type StepArgs, type StepResult, type ToolOutcome } from "./base";

const TEMPERATURE: ParamSpec = {
  name: "temperature",
  label: "Temperatura",
  type: "float",
  min: 0,
  max: 2,
  help: "Aleatoriedad. Algunos modelos de razonamiento no la admiten.",
};

export class OpenAIProvider extends Provider {
  id = "openai";
  name = "OpenAI";
  description = "Modelos GPT con tu propia API key.";
  keyHelp = "Crea una API key en platform.openai.com → API keys y pégala aquí.";

  suggestedModels() {
    return [];
  }

  private async request(method: string, path: string, payload: unknown, signal?: AbortSignal): Promise<any> {
    this.ensureConfigured();
    const attempts = this.settings.providerMaxRetries + 1;
    let last: ProviderError | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const timeout = AbortSignal.timeout(this.settings.providerTimeoutSeconds * 1000);
        const resp = await fetch(this.settings.openaiBaseUrl + path, {
          method,
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: payload ? JSON.stringify(payload) : undefined,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (resp.ok) return await resp.json();
        let detail = "";
        try {
          const data: any = await resp.json();
          detail = redact(data?.error?.message ?? "").slice(0, 300);
        } catch {
          /* sin cuerpo JSON */
        }
        const code = resp.status;
        if (code === 401) last = new ProviderError("OpenAI rechazó tu API key (401): no es válida o fue revocada.");
        else if (code === 404) last = new ProviderError(`OpenAI: modelo o ruta no encontrada (404). ${detail}`);
        else if (code === 429) last = new ProviderError("Límite de uso de OpenAI alcanzado (429). Reintenta más tarde.", true);
        else if (code >= 500) last = new ProviderError(`Error del servidor de OpenAI (${code}).`, true);
        else last = new ProviderError(`OpenAI rechazó la petición (${code}): ${detail}`);
      } catch (err: any) {
        if (signal?.aborted) throw new ProviderError("Llamada cancelada.");
        last = new ProviderError(err?.name === "TimeoutError" ? "OpenAI no respondió a tiempo." : "No se pudo conectar con OpenAI.", true);
      }
      if (!last.retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, Math.min(2 ** i * 1000, 8000)));
    }
    throw last!;
  }

  async listModels() {
    const data = await this.request("GET", "/models", null);
    return (data.data ?? []).map((m: any) => m.id).sort();
  }

  paramsFor(): ParamSpec[] {
    return [MAX_TOKENS, TEMPERATURE];
  }

  userMessage(text: string, atts: Attachment[]) {
    const content: any[] = [];
    for (const a of atts) {
      if (a.text !== undefined) content.push({ type: "text", text: wrapUntrusted(`adjunto:${a.name}`, a.text) });
      else if (a.mime.startsWith("image/")) content.push({ type: "image_url", image_url: { url: `data:${a.mime};base64,${a.b64}` } });
      else if (a.mime === "application/pdf") content.push({ type: "file", file: { filename: a.name, file_data: `data:application/pdf;base64,${a.b64}` } });
    }
    content.push({ type: "text", text: text || "(sin texto)" });
    return { role: "user", content };
  }

  async test() {
    const models = await this.listModels();
    return `Conexión correcta. ${models.length} modelos visibles con tu API key.`;
  }

  async step({ model, system, transcript, tools, params, signal }: StepArgs): Promise<StepResult> {
    const payload: Record<string, any> = {
      model,
      messages: [{ role: "system", content: system }, ...transcript],
      max_completion_tokens: Number(params.max_tokens ?? 4096),
    };
    if (params.temperature !== undefined) payload.temperature = params.temperature;
    if (tools.length) {
      payload.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    }
    const data = await this.request("POST", "/chat/completions", payload, signal);
    const choice = data.choices[0];
    const msg = choice.message;
    const toolCalls = (msg.tool_calls ?? []).map((tc: any) => {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = { _argumentos_invalidos: tc.function.arguments ?? "" };
      }
      return { id: tc.id, name: tc.function.name, input };
    });
    const assistant: any = { role: "assistant", content: msg.content ?? "" };
    if (msg.tool_calls) assistant.tool_calls = msg.tool_calls;
    return {
      text: msg.content ?? "",
      toolCalls,
      assistantMessages: [assistant],
      usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
      stopReason: choice.finish_reason ?? "",
    };
  }

  toolResultsMessages(outcomes: ToolOutcome[]) {
    return outcomes.map((o) => ({ role: "tool", tool_call_id: o.call.id, content: (o.isError ? "ERROR: " : "") + o.content }));
  }
}
