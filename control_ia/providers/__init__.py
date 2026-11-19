"""Registro de proveedores de IA.

Para añadir uno nuevo: crea una subclase de `Provider` y añádela a
PROVIDER_CLASSES. La UI, la configuración de credenciales y las pruebas de
conexión lo recogen automáticamente.
"""

from __future__ import annotations

from ..context import AppContext
from .anthropic_provider import AnthropicProvider
from .base import Provider, ProviderError, ProviderNotConfigured
from .demo import DemoProvider
from .openai_compatible import OllamaProvider, OpenAIProvider

PROVIDER_CLASSES: dict[str, type[Provider]] = {
    cls.id: cls for cls in (AnthropicProvider, OpenAIProvider, OllamaProvider, DemoProvider)
}

__all__ = [
    "PROVIDER_CLASSES",
    "Provider",
    "ProviderError",
    "ProviderNotConfigured",
    "get_provider",
    "available_provider_ids",
    "key_source",
]


def available_provider_ids(ctx: AppContext) -> list[str]:
    ids = list(PROVIDER_CLASSES)
    if not ctx.settings.enable_demo_provider:
        ids.remove("demo")
    return ids


def _stored_key(ctx: AppContext, provider_id: str) -> str:
    row = ctx.db.one("SELECT secret_enc FROM provider_settings WHERE provider_id = ?", (provider_id,))
    if not row or not row["secret_enc"]:
        return ""
    return ctx.box.decrypt(row["secret_enc"]).get("api_key", "")


def key_source(ctx: AppContext, provider_id: str) -> str | None:
    """De dónde sale la credencial: 'servidor' (cifrada en BD), 'entorno' o None."""
    if _stored_key(ctx, provider_id):
        return "servidor"
    if ctx.settings.env_api_keys.get(provider_id):
        return "entorno"
    return None


def get_provider(ctx: AppContext, provider_id: str) -> Provider:
    if provider_id not in available_provider_ids(ctx):
        raise ProviderNotConfigured(
            f"El proveedor '{provider_id or '(ninguno)'}' no está disponible. "
            "Elige uno en los ajustes del proyecto."
        )
    cls = PROVIDER_CLASSES[provider_id]
    api_key = _stored_key(ctx, provider_id) or ctx.settings.env_api_keys.get(provider_id, "")
    return cls(ctx.settings, api_key)
