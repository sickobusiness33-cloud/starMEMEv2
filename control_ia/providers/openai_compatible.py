"""Proveedores OpenAI y Ollama (APIs HTTP propias, sin SDK oficial en este repo).

OpenAI usa /v1/chat/completions con function calling. Ollama expone
/api/chat en local; si el servidor de Ollama no está en marcha, se muestra
como "pendiente de configuración" en vez de simular que funciona.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from ..security import redact
from .base import MAX_TOKENS_PARAM, ParamSpec, Provider, ProviderError, StepResult, ToolCall, ToolOutcome

TEMPERATURE = ParamSpec(
    "temperature",
    "Temperatura",
    "float",
    min=0,
    max=2,
    help="Aleatoriedad. Algunos modelos de razonamiento no la admiten.",
)


def _http_error(provider: str, exc: httpx.HTTPError | None, response: httpx.Response | None) -> ProviderError:
    if response is not None:
        code = response.status_code
        try:
            detail = response.json().get("error", "")
            if isinstance(detail, dict):
                detail = detail.get("message", "")
        except ValueError:
            detail = ""
        detail = redact(detail)[:300]
        if code == 401:
            return ProviderError(f"{provider} rechazó la credencial (401): no es válida o fue revocada.")
        if code == 404:
            return ProviderError(f"{provider}: modelo o ruta no encontrada (404). {detail}")
        if code == 429:
            return ProviderError(
                f"Límite de uso de {provider} alcanzado (429). Reintenta más tarde.", retryable=True
            )
        if code >= 500:
            return ProviderError(f"Error del servidor de {provider} ({code}).", retryable=True)
        return ProviderError(f"{provider} rechazó la petición ({code}): {detail}")
    if isinstance(exc, httpx.TimeoutException):
        return ProviderError(f"{provider} no respondió a tiempo.", retryable=True)
    return ProviderError(f"No se pudo conectar con {provider}: {redact(type(exc).__name__)}.", retryable=True)


class _HttpProvider(Provider):
    base_url = ""

    def _headers(self) -> dict[str, str]:
        return {}

    async def _request(self, method: str, path: str, payload: dict | None = None) -> dict[str, Any]:
        attempts = self.settings.provider_max_retries + 1
        last: ProviderError | None = None
        for attempt in range(attempts):
            try:
                async with httpx.AsyncClient(timeout=self.settings.provider_timeout_seconds) as client:
                    resp = await client.request(
                        method, self.base_url + path, json=payload, headers=self._headers()
                    )
                if resp.status_code < 400:
                    return resp.json()
                last = _http_error(self.name, None, resp)
            except httpx.HTTPError as exc:
                last = _http_error(self.name, exc, None)
            if not last.retryable or attempt == attempts - 1:
                break
            await asyncio.sleep(min(2**attempt, 8))
        assert last is not None
        raise last


class OpenAIProvider(_HttpProvider):
    id = "openai"
    name = "OpenAI"
    description = "Modelos GPT vía la API de OpenAI (o una API compatible con OPENAI_BASE_URL)."
    key_env_var = "OPENAI_API_KEY"
    key_help = "Crea una API key en platform.openai.com → API keys."

    def __init__(self, settings, api_key: str = "") -> None:
        super().__init__(settings, api_key)
        self.base_url = settings.openai_base_url

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    def suggested_models(self) -> list[str]:
        return []  # Se consultan en vivo: la lista de OpenAI cambia a menudo.

    async def list_models(self) -> list[str]:
        self.ensure_configured()
        data = await self._request("GET", "/models")
        return sorted(m["id"] for m in data.get("data", []))

    def params_for(self, model: str) -> list[ParamSpec]:
        return [MAX_TOKENS_PARAM, TEMPERATURE]

    async def test(self) -> str:
        models = await self.list_models()
        return f"Conexión correcta. {len(models)} modelos visibles para esta API key."

    def _prepare(self, system: str, transcript: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [{"role": "system", "content": system}, *transcript]

    async def step(self, *, model, system, transcript, tools, params) -> StepResult:
        self.ensure_configured()
        payload: dict[str, Any] = {
            "model": model,
            "messages": self._prepare(system, transcript),
            "max_completion_tokens": int(params.get("max_tokens", 4096)),
        }
        if "temperature" in params:
            payload["temperature"] = params["temperature"]
        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {"name": t.name, "description": t.description, "parameters": t.input_schema},
                }
                for t in tools
            ]
        data = await self._request("POST", "/chat/completions", payload)
        choice = data["choices"][0]
        msg = choice["message"]
        calls = []
        for tc in msg.get("tool_calls") or []:
            try:
                args = json.loads(tc["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {"_argumentos_invalidos": tc["function"].get("arguments", "")}
            calls.append(ToolCall(tc["id"], tc["function"]["name"], args))
        assistant = {"role": "assistant", "content": msg.get("content") or ""}
        if msg.get("tool_calls"):
            assistant["tool_calls"] = msg["tool_calls"]
        usage = data.get("usage") or {}
        return StepResult(
            msg.get("content") or "",
            calls,
            [assistant],
            {
                "input_tokens": usage.get("prompt_tokens", 0),
                "output_tokens": usage.get("completion_tokens", 0),
            },
            choice.get("finish_reason") or "",
        )

    def tool_results_messages(self, outcomes: list[ToolOutcome]) -> list[dict[str, Any]]:
        return [
            {
                "role": "tool",
                "tool_call_id": o.call.id,
                "content": ("ERROR: " if o.is_error else "") + o.content,
            }
            for o in outcomes
        ]


class OllamaProvider(_HttpProvider):
    id = "ollama"
    name = "Ollama (local)"
    description = "Modelos abiertos ejecutados en tu máquina con Ollama. No necesita API key."
    requires_key = False
    key_help = "Instala Ollama (ollama.com), arráncalo y descarga un modelo: `ollama pull llama3.1`."

    def __init__(self, settings, api_key: str = "") -> None:
        super().__init__(settings, api_key)
        self.base_url = settings.ollama_base_url

    def suggested_models(self) -> list[str]:
        return []

    async def list_models(self) -> list[str]:
        data = await self._request("GET", "/api/tags")
        return [m["name"] for m in data.get("models", [])]

    def params_for(self, model: str) -> list[ParamSpec]:
        return [MAX_TOKENS_PARAM, TEMPERATURE]

    async def test(self) -> str:
        try:
            models = await self.list_models()
        except ProviderError as exc:
            raise ProviderError(
                f"{exc.message} ¿Está Ollama arrancado en {self.base_url}? (configurable con OLLAMA_BASE_URL)"
            ) from exc
        if not models:
            raise ProviderError("Ollama responde pero no tiene modelos. Ejecuta `ollama pull <modelo>`.")
        return f"Ollama accesible en {self.base_url} con {len(models)} modelos."

    async def step(self, *, model, system, transcript, tools, params) -> StepResult:
        options: dict[str, Any] = {"num_predict": int(params.get("max_tokens", 4096))}
        if "temperature" in params:
            options["temperature"] = params["temperature"]
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "system", "content": system}, *transcript],
            "stream": False,
            "options": options,
        }
        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {"name": t.name, "description": t.description, "parameters": t.input_schema},
                }
                for t in tools
            ]
        data = await self._request("POST", "/api/chat", payload)
        msg = data.get("message", {})
        calls = [
            ToolCall(f"ollama-{i}", tc["function"]["name"], dict(tc["function"].get("arguments") or {}))
            for i, tc in enumerate(msg.get("tool_calls") or [])
        ]
        assistant = {"role": "assistant", "content": msg.get("content", "")}
        if msg.get("tool_calls"):
            assistant["tool_calls"] = msg["tool_calls"]
        return StepResult(
            msg.get("content", ""),
            calls,
            [assistant],
            {"input_tokens": data.get("prompt_eval_count", 0), "output_tokens": data.get("eval_count", 0)},
            data.get("done_reason", ""),
        )

    def tool_results_messages(self, outcomes: list[ToolOutcome]) -> list[dict[str, Any]]:
        return [{"role": "tool", "content": ("ERROR: " if o.is_error else "") + o.content} for o in outcomes]
