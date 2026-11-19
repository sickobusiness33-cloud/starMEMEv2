"""Proveedor Anthropic (Claude) usando el SDK oficial `anthropic`."""

from __future__ import annotations

from typing import Any

import anthropic

from ..security import redact
from .base import MAX_TOKENS_PARAM, ParamSpec, Provider, ProviderError, StepResult, ToolCall, ToolOutcome

# Modelos actuales. `sampling`: acepta temperature (los modelos más nuevos
# lo rechazan con un 400). `effort`: acepta output_config.effort.
CLAUDE_MODELS: dict[str, dict[str, bool]] = {
    "claude-opus-5": {"sampling": False, "effort": True},
    "claude-opus-5-5": {"sampling": False, "effort": True},
    "claude-fable-5-1": {"sampling": False, "effort": True},
    "claude-sonnet-5": {"sampling": False, "effort": True},
    "claude-opus-4-8": {"sampling": False, "effort": True},
    "claude-opus-4-7": {"sampling": False, "effort": True},
    "claude-opus-4-6": {"sampling": True, "effort": True},
    "claude-sonnet-4-6": {"sampling": True, "effort": True},
    "claude-haiku-4-5": {"sampling": True, "effort": False},
}
EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"]


def _capabilities(model: str) -> dict[str, bool]:
    # Modelo desconocido (p. ej. uno nuevo devuelto por /v1/models): no se
    # envían parámetros opcionales para no provocar errores 400.
    return CLAUDE_MODELS.get(model, {"sampling": False, "effort": False})


def _map_error(exc: Exception, model: str) -> ProviderError:
    if isinstance(exc, anthropic.AuthenticationError):
        return ProviderError("Anthropic rechazó la API key (401): no es válida o fue revocada.")
    if isinstance(exc, anthropic.PermissionDeniedError):
        return ProviderError("La API key de Anthropic no tiene permiso para esta operación (403).")
    if isinstance(exc, anthropic.NotFoundError):
        return ProviderError(f"El modelo '{model}' no existe o tu cuenta no tiene acceso (404).")
    if isinstance(exc, anthropic.RateLimitError):
        return ProviderError(
            "Límite de uso de Anthropic alcanzado (429). Reintenta en unos minutos.", retryable=True
        )
    if isinstance(exc, anthropic.BadRequestError):
        return ProviderError(f"Anthropic rechazó la petición (400): {redact(exc.message)}")
    if isinstance(exc, anthropic.APITimeoutError):
        return ProviderError("Anthropic no respondió a tiempo. Reintenta la tarea.", retryable=True)
    if isinstance(exc, anthropic.APIConnectionError):
        return ProviderError("No se pudo conectar con Anthropic (red o proxy).", retryable=True)
    if isinstance(exc, anthropic.APIStatusError):
        return ProviderError(
            f"Error del servidor de Anthropic ({exc.status_code}). Reintenta más tarde.",
            retryable=exc.status_code >= 500,
        )
    return ProviderError(f"Error inesperado llamando a Anthropic: {redact(exc)}")


class AnthropicProvider(Provider):
    id = "anthropic"
    name = "Anthropic (Claude)"
    description = "Modelos Claude vía la API de Anthropic. Admite herramientas."
    key_env_var = "ANTHROPIC_API_KEY"
    key_help = "Crea una API key en console.anthropic.com → API Keys."

    def _client(self) -> anthropic.AsyncAnthropic:
        self.ensure_configured()
        return anthropic.AsyncAnthropic(
            api_key=self.api_key,
            timeout=float(self.settings.provider_timeout_seconds),
            max_retries=self.settings.provider_max_retries,
        )

    def suggested_models(self) -> list[str]:
        return list(CLAUDE_MODELS)

    async def list_models(self) -> list[str]:
        client = self._client()
        try:
            page = await client.models.list(limit=100)
            return [m.id for m in page.data]
        except anthropic.AnthropicError as exc:
            raise _map_error(exc, "") from exc

    def params_for(self, model: str) -> list[ParamSpec]:
        caps = _capabilities(model)
        specs = [MAX_TOKENS_PARAM]
        if caps["effort"]:
            specs.append(
                ParamSpec(
                    "effort",
                    "Esfuerzo",
                    "choice",
                    choices=EFFORT_LEVELS,
                    help="Profundidad de razonamiento y gasto de tokens.",
                )
            )
        if caps["sampling"]:
            specs.append(
                ParamSpec(
                    "temperature",
                    "Temperatura",
                    "float",
                    min=0,
                    max=1,
                    help="Aleatoriedad de la respuesta (0 = más determinista).",
                )
            )
        return specs

    async def test(self) -> str:
        models = await self.list_models()
        return f"Conexión correcta. {len(models)} modelos disponibles para esta API key."

    async def step(self, *, model, system, transcript, tools, params) -> StepResult:
        client = self._client()
        kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": int(params.get("max_tokens", 4096)),
            "system": system,
            "messages": transcript,
        }
        if params.get("effort"):
            kwargs["output_config"] = {"effort": params["effort"]}
        if "temperature" in params:
            kwargs["temperature"] = params["temperature"]
        if tools:
            kwargs["tools"] = [
                {"name": t.name, "description": t.description, "input_schema": t.input_schema} for t in tools
            ]
        try:
            # Streaming + get_final_message evita timeouts HTTP con max_tokens altos.
            async with client.messages.stream(**kwargs) as stream:
                message = await stream.get_final_message()
        except anthropic.AnthropicError as exc:
            raise _map_error(exc, model) from exc

        if message.stop_reason == "refusal":
            raise ProviderError("El modelo declinó responder a esta petición (stop_reason=refusal).")
        content = [block.to_dict() for block in message.content]
        text = "".join(b.text for b in message.content if b.type == "text")
        calls = [ToolCall(b.id, b.name, dict(b.input)) for b in message.content if b.type == "tool_use"]
        if message.stop_reason == "max_tokens" and not calls:
            text += "\n\n[Respuesta cortada: se alcanzó el límite de tokens configurado.]"
        usage = {"input_tokens": message.usage.input_tokens, "output_tokens": message.usage.output_tokens}
        return StepResult(
            text, calls, [{"role": "assistant", "content": content}], usage, message.stop_reason or ""
        )

    def tool_results_messages(self, outcomes: list[ToolOutcome]) -> list[dict[str, Any]]:
        # Todas las respuestas de herramientas en un único mensaje de usuario.
        return [
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": o.call.id,
                        "content": o.content,
                        "is_error": o.is_error,
                    }
                    for o in outcomes
                ],
            }
        ]
