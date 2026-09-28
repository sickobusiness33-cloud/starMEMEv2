// Adapter de Cloudflare Workers AI (texto, visión e imagen) a través del binding AI.

import { b64ToBytes } from "../../b64";
import { estimateTokens, stripThinking, textOf, type ImageCall, type ImageOut, type TextCall, type TextOut } from "./types";

// JPEG 1×1 usado solo en AI_MODE=mock (tests locales, sin coste).
export const MOCK_JPEG = b64ToBytes(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
);

function toWorkersMessages(call: TextCall) {
  const vision = call.model.capabilities.includes("vision");
  const msgs: any[] = [{ role: "system", content: call.system }];
  for (const m of call.messages) {
    if (typeof m.content === "string" || !vision) msgs.push({ role: m.role, content: textOf(m.content) });
    else {
      msgs.push({
        role: m.role,
        content: m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.b64}` } })),
      });
    }
  }
  return msgs;
}

function parseText(res: any): string {
  if (typeof res === "string") return res;
  if (typeof res?.response === "string") return res.response;
  if (res?.choices?.[0]?.message?.content) return res.choices[0].message.content;
  if (typeof res?.output_text === "string") return res.output_text;
  // Formato Responses (gpt-oss): output[] con mensajes y bloques output_text.
  if (Array.isArray(res?.output)) {
    return res.output
      .filter((o: any) => o.type === "message")
      .flatMap((o: any) => o.content ?? [])
      .map((c: any) => c.text ?? "")
      .join("");
  }
  return res?.response ? JSON.stringify(res.response) : "";
}

export async function workersText(call: TextCall): Promise<TextOut> {
  const { env } = call;
  const messages = toWorkersMessages(call);
  if (env.AI_MODE === "mock") {
    const last = textOf(call.messages[call.messages.length - 1]?.content ?? "");
    if (last.includes("[forzar-error-gratis]")) throw new Error("Workers AI no disponible (simulado en test)");
    if (last.includes("[forzar-error-modelo]") && call.modelId === "@cf/meta/llama-3.3-70b-instruct-fp8-fast") throw new Error("modelo caído (simulado)");
    if (last.includes("[lento]")) await new Promise((r) => setTimeout(r, 1500));
    // El planificador del orquestador recibe una respuesta vacía en mock: usa su planificador por reglas.
    if (call.system.startsWith("[planner]")) return { text: "{}", input: 1, output: 1, estimated: true };
    const text = `[modelo de prueba ${call.modelId}] ${last.slice(0, 400)}`;
    return { text, input: estimateTokens(JSON.stringify(messages)), output: estimateTokens(text), estimated: true };
  }
  if (!env.AI) throw new Error("El binding de Workers AI no está configurado.");
  const input =
    call.model.format === "responses"
      ? { instructions: call.system, input: messages.slice(1).map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : textOf(m.content) })), max_output_tokens: call.maxTokens }
      : { messages, max_tokens: call.maxTokens };
  const res: any = await env.AI.run(call.modelId as any, input as any);
  const text = stripThinking(parseText(res));
  if (!text) throw new Error(`${call.model.label} devolvió una respuesta vacía.`);
  const u = res?.usage ?? {};
  const inTok = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const outTok = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  return inTok || outTok
    ? { text, input: inTok, output: outTok, estimated: false }
    : { text, input: estimateTokens(JSON.stringify(messages)), output: estimateTokens(text), estimated: true };
}

async function toBytes(res: any): Promise<Uint8Array> {
  if (res instanceof Uint8Array) return res;
  if (res instanceof ArrayBuffer) return new Uint8Array(res);
  if (res && typeof res.getReader === "function") return new Uint8Array(await new Response(res).arrayBuffer());
  if (typeof res?.image === "string") return b64ToBytes(res.image);
  throw new Error("El modelo de imagen no devolvió ninguna imagen.");
}

const round64 = (n: number) => Math.max(256, Math.round(n / 64) * 64);

export async function workersImage(call: ImageCall): Promise<ImageOut> {
  const { env, model } = call;
  if (env.AI_MODE === "mock") {
    if (call.prompt.includes("[forzar-error-imagen]") && model.id === "@cf/black-forest-labs/flux-1-schnell") throw new Error("modelo de imagen caído (simulado)");
    return { bytes: MOCK_JPEG, mime: "image/jpeg" };
  }
  if (!env.AI) throw new Error("El binding de Workers AI no está configurado.");
  const max = model.maxSize ?? 1024;
  const width = Math.min(round64(call.width), max);
  const height = Math.min(round64(call.height), max);
  let input: Record<string, unknown>;
  if (model.format === "flux") {
    // FLUX.1 schnell solo acepta prompt y steps (≤ 8); no admite semilla.
    input = { prompt: call.prompt.slice(0, 2048), steps: 6 };
  } else {
    input = {
      prompt: call.prompt.slice(0, 2048),
      negative_prompt: (call.negative || "blurry, low quality, watermark, text artifacts").slice(0, 1000),
      width,
      height,
      num_steps: model.id.includes("lightning") || model.id.includes("lcm") ? 8 : 20,
      guidance: model.id.includes("lcm") ? 1.5 : 7.5,
      ...(call.seed !== undefined ? { seed: call.seed } : {}),
    };
  }
  const res: any = await env.AI.run(model.id as any, input as any);
  const bytes = await toBytes(res);
  if (bytes.length < 100) throw new Error("El modelo devolvió una imagen vacía.");
  const mime = bytes[0] === 0x89 ? "image/png" : "image/jpeg";
  return { bytes, mime };
}
