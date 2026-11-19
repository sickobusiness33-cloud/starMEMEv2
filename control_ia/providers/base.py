"""Interfaz común de proveedores de IA.

Cada proveedor traduce entre el formato nativo de su API y un pequeño
contrato común (`step` devuelve texto + llamadas a herramientas). La
transcripción se guarda en el formato nativo del proveedor, así los
bloques especiales (p. ej. `thinking` de Claude) se devuelven intactos al
continuar tras una confirmación.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from ..settings import Settings


class ProviderError(Exception):
    """Error con un mensaje apto para mostrarse al usuario (sin secretos)."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable


class ProviderNotConfigured(ProviderError):
    pass


@dataclass
class ToolDef:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass
class ToolOutcome:
    call: ToolCall
    content: str
    is_error: bool = False


@dataclass
class StepResult:
    text: str
    tool_calls: list[ToolCall]
    assistant_messages: list[dict[str, Any]]
    usage: dict[str, int] = field(default_factory=dict)
    stop_reason: str = ""


@dataclass
class ParamSpec:
    name: str
    label: str
    type: str  # "int" | "float" | "choice"
    default: Any = None
    min: float | None = None
    max: float | None = None
    choices: list[str] | None = None
    help: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


MAX_TOKENS_PARAM = ParamSpec(
    "max_tokens",
    "Máx. tokens de respuesta",
    "int",
    default=4096,
    min=1,
    max=64000,
    help="Tope de tokens que puede generar cada paso. Limita coste y longitud.",
)


class Provider(ABC):
    id: str = ""
    name: str = ""
    description: str = ""
    requires_key: bool = True
    key_env_var: str = ""
    key_help: str = ""
    supports_tools: bool = True
    is_demo: bool = False

    def __init__(self, settings: Settings, api_key: str = "") -> None:
        self.settings = settings
        self.api_key = api_key

    def configuration_problem(self) -> str | None:
        """None si está listo; si no, un mensaje explicando qué falta."""
        if self.requires_key and not self.api_key:
            return (
                f"El proveedor {self.name} no está configurado: falta la API key. "
                f"Añádela en Configuración → Proveedores o con la variable {self.key_env_var}."
            )
        return None

    def ensure_configured(self) -> None:
        problem = self.configuration_problem()
        if problem:
            raise ProviderNotConfigured(problem)

    @abstractmethod
    def suggested_models(self) -> list[str]: ...

    async def list_models(self) -> list[str]:
        """Modelos reales disponibles con la credencial actual (consulta la API)."""
        return self.suggested_models()

    def params_for(self, model: str) -> list[ParamSpec]:
        return [MAX_TOKENS_PARAM]

    def clean_params(self, model: str, params: dict[str, Any]) -> dict[str, Any]:
        """Descarta parámetros no compatibles con el modelo y valida rangos."""
        out: dict[str, Any] = {}
        for spec in self.params_for(model):
            value = params.get(spec.name)
            if value in (None, ""):
                if spec.default is not None:
                    out[spec.name] = spec.default
                continue
            if spec.type == "choice":
                if value not in (spec.choices or []):
                    raise ProviderError(f"Valor no válido para {spec.label}: {value}")
                out[spec.name] = value
                continue
            num = int(value) if spec.type == "int" else float(value)
            if spec.min is not None and num < spec.min or spec.max is not None and num > spec.max:
                raise ProviderError(f"{spec.label} debe estar entre {spec.min} y {spec.max}.")
            out[spec.name] = num
        return out

    @abstractmethod
    async def test(self) -> str:
        """Comprueba la conexión real. Devuelve un mensaje o lanza ProviderError."""

    def history_messages(self, history: list[tuple[str, str]]) -> list[dict[str, Any]]:
        return [{"role": role, "content": text} for role, text in history]

    @abstractmethod
    async def step(
        self,
        *,
        model: str,
        system: str,
        transcript: list[dict[str, Any]],
        tools: list[ToolDef],
        params: dict[str, Any],
    ) -> StepResult: ...

    @abstractmethod
    def tool_results_messages(self, outcomes: list[ToolOutcome]) -> list[dict[str, Any]]: ...
