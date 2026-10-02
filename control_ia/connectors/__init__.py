"""Registro y persistencia de conectores.

Para añadir una integración nueva: subclase de `Connector` con su
`ConnectorType` y añádela a CONNECTOR_CLASSES.

Estados posibles (columna `status`):
- pending_config: faltan datos obligatorios.
- untested: datos completos pero nunca verificados (o cambiados desde la
  última prueba). No se puede activar hasta probarlo.
- connected: la última prueba real contra el servicio fue correcta.
- error: la última prueba o el último uso falló (ver last_error).
"""

from __future__ import annotations

from typing import Any

from ..context import AppContext
from ..db import loads
from .base import Connector, ConnectorError
from .github import GitHubConnector
from .webhooks import DiscordWebhookConnector, SlackWebhookConnector

CONNECTOR_CLASSES: dict[str, type[Connector]] = {
    cls.type.id: cls for cls in (GitHubConnector, DiscordWebhookConnector, SlackWebhookConnector)
}

__all__ = ["CONNECTOR_CLASSES", "Connector", "ConnectorError", "instantiate", "public_connector"]


def instantiate(ctx: AppContext, row: dict[str, Any]) -> Connector:
    cls = CONNECTOR_CLASSES[row["type"]]
    return cls(loads(row["config_json"]), ctx.box.decrypt(row["secret_enc"]))


def public_connector(ctx: AppContext, row: dict[str, Any]) -> dict[str, Any]:
    """Representación para el navegador: NUNCA incluye valores secretos."""
    cls = CONNECTOR_CLASSES.get(row["type"])
    secret_names = [f.name for f in cls.type.fields if f.secret] if cls else []
    stored = ctx.box.decrypt(row["secret_enc"]) if row["secret_enc"] else {}
    return {
        "id": row["id"],
        "type": row["type"],
        "type_name": cls.type.name if cls else row["type"],
        "name": row["name"],
        "config": loads(row["config_json"]),
        "secrets_set": {name: bool(stored.get(name)) for name in secret_names},
        "enabled": bool(row["enabled"]),
        "status": row["status"],
        "last_error": row["last_error"],
        "last_tested_at": row["last_tested_at"],
        "last_used_at": row["last_used_at"],
        "created_at": row["created_at"],
        "projects": [
            p["name"]
            for p in ctx.db.all(
                "SELECT p.name FROM project_connectors pc JOIN projects p ON p.id = pc.project_id"
                " WHERE pc.connector_id = ? ORDER BY p.name",
                (row["id"],),
            )
        ],
    }
