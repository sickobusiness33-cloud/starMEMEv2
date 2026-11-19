"""Interfaz común de conectores (integraciones externas).

Un conector declara:
- qué campos necesita (y cuáles son secretos: esos se cifran y nunca se
  devuelven al navegador),
- qué permisos requiere y por qué (se muestra antes de conectar),
- una prueba de conexión REAL (`test`) que no publica nada,
- acciones que usan las herramientas (`tools.py`).
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..security import redact

HTTP_TIMEOUT = 20.0


class ConnectorError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = redact(message)


@dataclass
class FieldSpec:
    name: str
    label: str
    secret: bool = False
    required: bool = True
    placeholder: str = ""
    help: str = ""
    pattern: str = ""

    def as_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


@dataclass
class ConnectorType:
    id: str
    name: str
    description: str
    permissions: list[str]
    setup_steps: list[str]
    fields: list[FieldSpec] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "permissions": self.permissions,
            "setup_steps": self.setup_steps,
            "fields": [f.as_dict() for f in self.fields],
        }


class Connector(ABC):
    type: ConnectorType

    def __init__(self, config: dict[str, str], secrets: dict[str, str]) -> None:
        self.config = config
        self.secrets = secrets

    @classmethod
    def validate(cls, config: dict[str, str], secrets: dict[str, str], *, partial: bool = False) -> list[str]:
        """Errores de formato. Con partial=True no exige campos ausentes."""
        errors = []
        for spec in cls.type.fields:
            source = secrets if spec.secret else config
            value = (source.get(spec.name) or "").strip()
            if not value:
                continue
            if spec.pattern and not re.fullmatch(spec.pattern, value):
                errors.append(f"{spec.label}: formato no válido.")
        return errors

    def missing_fields(self) -> list[str]:
        missing = []
        for spec in self.type.fields:
            source = self.secrets if spec.secret else self.config
            if spec.required and not (source.get(spec.name) or "").strip():
                missing.append(spec.label)
        return missing

    @abstractmethod
    async def test(self) -> str:
        """Verifica credenciales contra el servicio real sin publicar nada."""

    async def _http(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
                return await client.request(method, url, **kwargs)
        except httpx.TimeoutException as exc:
            raise ConnectorError(f"{self.type.name} no respondió a tiempo.") from exc
        except httpx.HTTPError as exc:
            raise ConnectorError(
                f"No se pudo conectar con {self.type.name} ({type(exc).__name__}). "
                "Revisa la red o el proxy del servidor."
            ) from exc
