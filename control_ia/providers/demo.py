"""Proveedor de demostración: NO es IA.

Existe para poder probar la plataforma (estados, historial, herramientas,
confirmaciones) sin API keys. Sus respuestas llevan siempre la etiqueta
"[DEMO — no generado por IA]" y la UI lo marca como demostración.

Comandos que entiende en el mensaje del usuario:
- `/herramienta <nombre> {json}`  pide ejecutar una herramienta.
- `/lento <segundos>`             tarda en responder (para probar Detener).
- `/fallar`                       falla a propósito (para probar Reintentar).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from .base import Provider, ProviderError, StepResult, ToolCall, ToolOutcome

LABEL = "[DEMO — no generado por IA]"


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict):
            parts.append(str(block.get("text") or block.get("content") or ""))
    return "\n".join(parts)


class DemoProvider(Provider):
    id = "demo"
    name = "Demostración local (no es IA)"
    description = "Respuestas deterministas para probar la plataforma sin credenciales. No usa ningún modelo."
    requires_key = False
    is_demo = True
    key_help = "No necesita configuración."

    def suggested_models(self) -> list[str]:
        return ["demo-eco"]

    async def test(self) -> str:
        return "Proveedor de demostración disponible (no llama a ninguna IA)."

    async def step(self, *, model, system, transcript, tools, params) -> StepResult:
        last = transcript[-1]
        if last.get("role") == "tool_results":
            summary = "\n".join(
                f"- {r['name']}: {'ERROR ' if r['is_error'] else ''}{r['content'][:400]}"
                for r in last["results"]
            )
            text = f"{LABEL}\nResultado de las herramientas:\n{summary}"
            return StepResult(text, [], [{"role": "assistant", "content": text}], {}, "end_turn")

        user_text = _text_of(last.get("content")).strip()
        if user_text.startswith("/fallar"):
            raise ProviderError("Fallo simulado por el proveedor de demostración (/fallar).")
        if user_text.startswith("/lento"):
            try:
                seconds = min(float(user_text.split()[1]), 120)
            except (IndexError, ValueError):
                seconds = 10
            await asyncio.sleep(seconds)
        if user_text.startswith("/herramienta"):
            parts = user_text.split(maxsplit=2)
            name = parts[1] if len(parts) > 1 else ""
            try:
                args = json.loads(parts[2]) if len(parts) > 2 else {}
            except json.JSONDecodeError:
                args = {}
            call = ToolCall(f"demo-{len(transcript)}", name, args)
            note = f"{LABEL}\nSolicito la herramienta `{name}`."
            return StepResult(
                note,
                [call],
                [
                    {
                        "role": "assistant",
                        "content": note,
                        "tool_call": {"id": call.id, "name": name, "input": args},
                    }
                ],
                {},
                "tool_use",
            )

        previous = sum(1 for m in transcript[:-1] if m.get("role") == "user")
        instructions = system.split("## Instrucciones del proyecto", 1)[-1].strip().splitlines()
        first_instr = instructions[0][:120] if instructions and instructions[0] else "(ninguna)"
        tool_names = ", ".join(t.name for t in tools) or "ninguna"
        text = (
            f"{LABEL}\n"
            f"Mensaje recibido: «{user_text[:500]}»\n"
            f"Modelo: {model} · mensajes previos del usuario en esta conversación: {previous}\n"
            f"Instrucciones activas del proyecto: {first_instr}\n"
            f"Herramientas habilitadas: {tool_names}"
        )
        return StepResult(
            text,
            [],
            [{"role": "assistant", "content": text}],
            {"input_tokens": 0, "output_tokens": 0},
            "end_turn",
        )

    def tool_results_messages(self, outcomes: list[ToolOutcome]) -> list[dict[str, Any]]:
        return [
            {
                "role": "tool_results",
                "results": [
                    {"name": o.call.name, "content": o.content, "is_error": o.is_error} for o in outcomes
                ],
            }
        ]
