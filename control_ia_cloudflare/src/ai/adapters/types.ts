// Contrato común de los AGENT/MODEL ADAPTERS: cada proveedor implementa
// callText y/o callImage. El Model Router solo conoce esta interfaz.

import type { Env } from "../../env";
import type { ModelInfo } from "../models";

export type Part = { type: "text"; text: string } | { type: "image"; mime: string; b64: string };

export interface ChatMsg {
  role: "user" | "assistant";
  content: string | Part[];
}

export interface TextCall {
  env: Env;
  model: ModelInfo;
  /** Id real a llamar (p. ej. CLAUDE_MODEL puede diferir del catálogo). */
  modelId: string;
  system: string;
  messages: ChatMsg[];
  maxTokens: number;
  apiKey?: string;
  signal?: AbortSignal;
}

export interface TextOut {
  text: string;
  input: number;
  output: number;
  estimated: boolean;
}

export interface ImageCall {
  env: Env;
  model: ModelInfo;
  mode: "t2i" | "i2i" | "inpaint" | "variation" | "upscale";
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  seed?: number;
  strength?: number;
  image?: Uint8Array;
  mask?: Uint8Array;
  apiKey?: string;
}

export interface ImageOut {
  bytes: Uint8Array;
  mime: string;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function textOf(content: ChatMsg["content"]): string {
  return typeof content === "string" ? content : content.filter((p) => p.type === "text").map((p) => (p as any).text).join("\n");
}

export function hasImages(messages: ChatMsg[]) {
  return messages.some((m) => typeof m.content !== "string" && m.content.some((p) => p.type === "image"));
}

/** Quita el razonamiento interno (<think>…</think>) que devuelven algunos modelos. */
export function stripThinking(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();
}
