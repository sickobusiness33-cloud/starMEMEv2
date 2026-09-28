// Proveedor de demostración: NO es IA. Sirve para probar la plataforma sin claves.
// Comandos: /herramienta <nombre> {json} · /lento <segundos> · /fallar

import { Provider, ProviderError, type StepArgs, type StepResult, type ToolOutcome } from "./base";

const LABEL = "[DEMO — no generado por IA]";

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b: any) => String(b?.text ?? b?.content ?? "")).join("\n")
      : "";

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new ProviderError("Llamada cancelada."));
    });
  });
}

export class DemoProvider extends Provider {
  id = "demo";
  name = "Demostración (no es IA)";
  description = "Respuestas fijas para probar la plataforma sin claves. No usa ningún modelo.";
  requiresKey = false;
  isDemo = true;
  keyHelp = "No necesita configuración.";

  suggestedModels() {
    return ["demo-eco"];
  }

  async test() {
    return "Proveedor de demostración disponible (no llama a ninguna IA).";
  }

  async step({ model, system, transcript, tools, signal }: StepArgs): Promise<StepResult> {
    const last = transcript[transcript.length - 1];
    if (last?.role === "tool_results") {
      const summary = last.results
        .map((r: any) => `- ${r.name}: ${r.is_error ? "ERROR " : ""}${String(r.content).slice(0, 400)}`)
        .join("\n");
      const text = `${LABEL}\nResultado de las herramientas:\n${summary}`;
      return { text, toolCalls: [], assistantMessages: [{ role: "assistant", content: text }], usage: {}, stopReason: "end_turn" };
    }
    const userText = textOf(last?.content).trim();
    if (userText.startsWith("/fallar")) throw new ProviderError("Fallo simulado por el proveedor de demostración (/fallar).");
    if (userText.startsWith("/lento")) {
      const secs = Math.min(Number(userText.split(/\s+/)[1]) || 10, 120);
      await sleep(secs * 1000, signal);
    }
    if (userText.startsWith("/herramienta")) {
      const m = userText.match(/^\/herramienta\s+(\S+)\s*(.*)$/s);
      const name = m?.[1] ?? "";
      let input: Record<string, unknown> = {};
      try {
        input = m?.[2] ? JSON.parse(m[2]) : {};
      } catch {
        input = {};
      }
      const call = { id: `demo-${transcript.length}`, name, input };
      const note = `${LABEL}\nSolicito la herramienta \`${name}\`.`;
      return { text: note, toolCalls: [call], assistantMessages: [{ role: "assistant", content: note }], usage: {}, stopReason: "tool_use" };
    }
    const previous = transcript.slice(0, -1).filter((m: any) => m.role === "user").length;
    const instr = (system.split("## Instrucciones del proyecto")[1] ?? "").trim().split("\n")[0]?.slice(0, 120) || "(ninguna)";
    const text = [
      LABEL,
      `Mensaje recibido: «${userText.slice(0, 500)}»`,
      `Modelo: ${model} · mensajes previos del usuario en esta conversación: ${previous}`,
      `Instrucciones activas del proyecto: ${instr}`,
      `Herramientas habilitadas: ${tools.map((t) => t.name).join(", ") || "ninguna"}`,
    ].join("\n");
    return { text, toolCalls: [], assistantMessages: [{ role: "assistant", content: text }], usage: { input_tokens: 0, output_tokens: 0 }, stopReason: "end_turn" };
  }

  toolResultsMessages(outcomes: ToolOutcome[]) {
    return [{ role: "tool_results", results: outcomes.map((o) => ({ name: o.call.name, content: o.content, is_error: o.isError })) }];
  }
}
