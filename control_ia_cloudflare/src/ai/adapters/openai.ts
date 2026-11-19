// Adapter de OpenAI (solo con la API del propio usuario): texto e imagen.

import { b64ToBytes } from "../../b64";
import type { ImageCall, ImageOut, TextCall, TextOut } from "./types";

function base(env: TextCall["env"]) {
  return (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
}

const VENDOR_NAME = { openai: "OpenAI", gemini: "Gemini", groq: "Groq" } as const;
async function errorOf(r: Response, vendor: keyof typeof VENDOR_NAME = "openai") {
  const data: any = await r.json().catch(() => ({}));
  const msg = Array.isArray(data) ? data[0]?.error?.message : data?.error?.message;
  return new Error(`${VENDOR_NAME[vendor]} ${r.status}: ${msg ?? r.statusText}`);
}

export async function openaiText(call: TextCall): Promise<TextOut> {
  const messages = [
    { role: "system", content: call.system },
    ...call.messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.b64}` } })),
    })),
  ];
  const vendor = call.vendor ?? "openai";
  const body: Record<string, unknown> = { model: call.modelId, messages };
  if (vendor === "openai") body.max_completion_tokens = call.maxTokens;
  else {
    // Groq limita tokens por minuto en el plan gratuito: no se reservan más de 6.000 de salida.
    body.max_tokens = vendor === "groq" ? Math.min(call.maxTokens, 6000) : call.maxTokens;
    // Gemini 2.5+ «piensa» antes de responder: razonamiento bajo para que no se coma los tokens de la respuesta.
    if (vendor === "gemini" && /2\.5|latest|-3/.test(call.modelId)) body.reasoning_effort = "low";
  }
  const r = await fetch(`${call.baseUrl ?? base(call.env)}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${call.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: call.signal ?? AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw await errorOf(r, vendor);
  const data: any = await r.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    input: data.usage?.prompt_tokens ?? 0,
    output: data.usage?.completion_tokens ?? 0,
    estimated: false,
  };
}

export async function openaiImage(call: ImageCall): Promise<ImageOut> {
  const size = call.width > call.height ? "1536x1024" : call.height > call.width ? "1024x1536" : "1024x1024";
  let r: Response;
  if (call.image) {
    const form = new FormData();
    form.append("model", call.model.id);
    form.append("prompt", call.prompt.slice(0, 4000));
    form.append("size", size);
    form.append("image", new Blob([call.image], { type: "image/png" }), "image.png");
    if (call.mask) form.append("mask", new Blob([call.mask], { type: "image/png" }), "mask.png");
    r = await fetch(`${base(call.env)}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${call.apiKey}` }, body: form, signal: AbortSignal.timeout(180_000) });
  } else {
    r = await fetch(`${base(call.env)}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${call.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: call.model.id, prompt: call.prompt.slice(0, 4000), size }),
      signal: AbortSignal.timeout(180_000),
    });
  }
  if (!r.ok) throw await errorOf(r);
  const data: any = await r.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI no devolvió ninguna imagen.");
  return { bytes: b64ToBytes(b64), mime: "image/png" };
}
