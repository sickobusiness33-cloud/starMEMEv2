// Herramientas de los agentes del Hub. Todas son de solo lectura o generan
// contenido nuevo; ninguna accede a secretos, a la base de datos, al sistema
// de archivos, a cuentas ni a wallets. El resultado externo se marca como datos.

import { generateImage, type CallContext } from "../ai/router";
import { untrusted } from "../tools";
import type { AgentToolId } from "./types";

export interface ToolResult {
  text: string;
  image?: string; // base64 JPEG
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)|^172\.(1[6-9]|2\d|3[01])\./i;

/** URLs que aparecen literalmente en lo que escribió el usuario (las únicas que web_read puede leer). */
export function userUrls(input: string): string[] {
  return [...new Set((input.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))].slice(0, 3);
}

function queriesFrom(text: string, fallback: string): string[] {
  const out: string[] = [];
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (Array.isArray(j?.queries)) out.push(...j.queries.map(String));
  } catch {
    /* no era JSON */
  }
  if (!out.length) {
    for (const line of text.split("\n")) {
      const q = line.replace(/^[\s\-*\d.)"]+/, "").replace(/["]+$/, "").trim();
      if (q.length > 2 && q.length < 90) out.push(q);
    }
  }
  if (!out.length) out.push(fallback.slice(0, 120));
  return [...new Set(out)].slice(0, 3);
}

async function wikipedia(queries: string[]): Promise<string> {
  const parts: string[] = [];
  for (const q of queries) {
    for (const lang of ["es", "en"]) {
      try {
        const s = await fetch(
          `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=2&srsearch=${encodeURIComponent(q)}`,
          { headers: { "User-Agent": "ControlIA/1.0 (agent hub)" }, signal: AbortSignal.timeout(12_000) },
        );
        const data: any = await s.json();
        const hits = data?.query?.search ?? [];
        if (!hits.length) continue;
        for (const hit of hits.slice(0, 2)) {
          const title = hit.title as string;
          const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
            headers: { "User-Agent": "ControlIA/1.0 (agent hub)" },
            signal: AbortSignal.timeout(12_000),
          });
          if (!r.ok) continue;
          const sum: any = await r.json();
          parts.push(`### ${sum.title}\nFuente: ${sum.content_urls?.desktop?.page ?? ""} (Wikipedia, CC BY-SA)\n${String(sum.extract ?? "").slice(0, 1500)}`);
        }
        break;
      } catch {
        /* se prueba el siguiente idioma o consulta */
      }
    }
  }
  return parts.length ? parts.join("\n\n") : "No se encontraron artículos en Wikipedia para esas búsquedas.";
}

async function webRead(urls: string[]): Promise<string> {
  if (!urls.length) return "No escribiste ninguna URL: este agente solo lee páginas que tú indiques.";
  const parts: string[] = [];
  for (const u of urls) {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      parts.push(`(${u}: URL no válida)`);
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol) || PRIVATE_HOST.test(url.hostname)) {
      parts.push(`(${u}: solo se permiten páginas públicas)`);
      continue;
    }
    try {
      const r = await fetch(url.toString(), { headers: { "User-Agent": "ControlIA/1.0" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
      if (!r.ok) {
        parts.push(`(${u}: la página respondió ${r.status})`);
        continue;
      }
      const type = r.headers.get("content-type") ?? "";
      if (!/text|html|json|xml/.test(type)) {
        parts.push(`(${u}: tipo de contenido no legible: ${type})`);
        continue;
      }
      const text = (await r.text())
        .slice(0, 250_000)
        .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 12_000);
      parts.push(untrusted(`web:${u}`, text));
    } catch {
      parts.push(`(${u}: no se pudo descargar)`);
    }
  }
  return parts.join("\n\n");
}

export async function runAgentTool(ctx: CallContext, tool: AgentToolId, text: string, userInput: string): Promise<ToolResult> {
  if (tool === "wikipedia_search" && ctx.env.AI_MODE === "mock") {
    // Solo tests locales: sin red, resultado determinista.
    return { text: untrusted("wikipedia", `### Artículo de prueba\nFuente: https://es.wikipedia.org/wiki/Prueba (Wikipedia, CC BY-SA)\nBúsquedas: ${queriesFrom(text, userInput).join(" | ")}`) };
  }
  if (tool === "wikipedia_search") return { text: untrusted("wikipedia", await wikipedia(queriesFrom(text, userInput))) };
  if (tool === "web_read") return { text: await webRead(userUrls(userInput)) };
  if (tool === "image_generate") {
    // Si la etapa anterior terminó con una línea «PROMPT: …», solo se usa esa parte.
    const idx = text.lastIndexOf("PROMPT:");
    const prompt = (idx >= 0 ? text.slice(idx + 7) : text).trim() || userInput;
    const img = await generateImage(ctx, prompt);
    return { text: `Imagen generada con ${img.model} a partir de: ${prompt.slice(0, 500)}`, image: img.b64 };
  }
  throw new Error(`Herramienta desconocida: ${tool}`);
}
