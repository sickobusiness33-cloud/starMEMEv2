"""Configuración de Control IA cargada desde variables de entorno.

Se separan explícitamente dos cosas:
- Configuración pública (puertos, límites, rutas): se puede mostrar en la UI.
- Secretos (clave de cifrado, API keys por entorno): nunca salen del servidor.
  Por eso no forman parte de `public_dict()`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _get_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def _get_bool(name: str, default: bool) -> bool:
    return os.getenv(name, "true" if default else "false").strip().lower() in {"1", "true", "yes", "si", "sí"}


@dataclass(frozen=True)
class Settings:
    data_dir: str = "data"
    host: str = "127.0.0.1"
    port: int = 8000
    cookie_secure: bool = False
    session_hours: int = 12
    max_concurrent_runs: int = 2
    runs_per_minute_per_user: int = 10
    login_attempts_per_minute: int = 5
    provider_timeout_seconds: int = 120
    provider_max_retries: int = 2
    max_file_bytes: int = 256 * 1024
    enable_demo_provider: bool = True
    openai_base_url: str = "https://api.openai.com/v1"
    ollama_base_url: str = "http://127.0.0.1:11434"
    # --- Secretos: nunca se exponen por la API ---
    secret_key: str = field(default="", repr=False)
    env_api_keys: dict[str, str] = field(default_factory=dict, repr=False)

    def public_dict(self) -> dict[str, object]:
        return {
            "max_concurrent_runs": self.max_concurrent_runs,
            "runs_per_minute_per_user": self.runs_per_minute_per_user,
            "provider_timeout_seconds": self.provider_timeout_seconds,
            "provider_max_retries": self.provider_max_retries,
            "max_file_bytes": self.max_file_bytes,
            "session_hours": self.session_hours,
            "enable_demo_provider": self.enable_demo_provider,
            "cookie_secure": self.cookie_secure,
        }


def load_settings() -> Settings:
    env_keys = {
        "anthropic": os.getenv("ANTHROPIC_API_KEY", ""),
        "openai": os.getenv("OPENAI_API_KEY", ""),
    }
    return Settings(
        data_dir=os.getenv("CONTROL_DATA_DIR", "data"),
        host=os.getenv("CONTROL_HOST", "127.0.0.1"),
        port=_get_int("CONTROL_PORT", _get_int("PORT", 8000)),
        cookie_secure=_get_bool("CONTROL_COOKIE_SECURE", False),
        session_hours=_get_int("CONTROL_SESSION_HOURS", 12),
        max_concurrent_runs=_get_int("CONTROL_MAX_CONCURRENT_RUNS", 2),
        runs_per_minute_per_user=_get_int("CONTROL_RUNS_PER_MINUTE", 10),
        login_attempts_per_minute=_get_int("CONTROL_LOGIN_ATTEMPTS_PER_MINUTE", 5),
        provider_timeout_seconds=_get_int("CONTROL_PROVIDER_TIMEOUT_SECONDS", 120),
        provider_max_retries=_get_int("CONTROL_PROVIDER_MAX_RETRIES", 2),
        max_file_bytes=_get_int("CONTROL_MAX_FILE_BYTES", 256 * 1024),
        enable_demo_provider=_get_bool("CONTROL_ENABLE_DEMO_PROVIDER", True),
        openai_base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/"),
        secret_key=os.getenv("CONTROL_SECRET_KEY", ""),
        env_api_keys={k: v for k, v in env_keys.items() if v},
    )


def validate_settings(settings: Settings) -> list[str]:
    """Problemas de configuración que impiden arrancar (lista vacía si todo bien)."""
    problemas = []
    if settings.max_concurrent_runs <= 0:
        problemas.append("CONTROL_MAX_CONCURRENT_RUNS debe ser mayor que 0.")
    if settings.runs_per_minute_per_user <= 0:
        problemas.append("CONTROL_RUNS_PER_MINUTE debe ser mayor que 0.")
    if settings.provider_timeout_seconds <= 0:
        problemas.append("CONTROL_PROVIDER_TIMEOUT_SECONDS debe ser mayor que 0.")
    if settings.session_hours <= 0:
        problemas.append("CONTROL_SESSION_HOURS debe ser mayor que 0.")
    return problemas
