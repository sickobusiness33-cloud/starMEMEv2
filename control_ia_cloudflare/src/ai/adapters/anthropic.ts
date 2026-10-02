// Adapter de Claude (Anthropic): clave de la plataforma o del usuario.

import Anthropic from "@anthropic-ai/sdk";
import { RouterError } from "../errors";
import type { TextCall, TextOut } from "./types";

export async function anthropicText(call: TextCall): Promise<TextOut> {
  const client = new Anthropic({ apiKey: call.apiKey, baseURL: call.env.ANTHROPIC_BASE_URL || undefined, timeout: 120_000, maxRetries: 1 });
  const messages = call.messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) =>
            p.type === "text" ? { type: "text" as const, text: p.text } : { type: "image" as const, source: { type: "base64" as const, media_type: p.mime as any, data: p.b64 } },
          ),
  }));
  const msg = await client.messages.create({ model: call.modelId, max_tokens: call.maxTokens, system: call.system, messages }, { signal: call.signal });
  if (msg.stop_reason === "refusal") throw new RouterError("Claude declinó responder a esta petición.", "refusal");
  const text = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return { text, input: msg.usage.input_tokens, output: msg.usage.output_tokens, estimated: false };
}
