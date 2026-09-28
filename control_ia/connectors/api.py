"""Endpoints de conectores: crear, configurar, probar, activar y desconectar."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import audit
from ..auth import current_user
from ..context import AppContext, get_ctx
from ..db import dumps, loads, now_iso
from . import CONNECTOR_CLASSES, ConnectorError, instantiate, public_connector

router = APIRouter(prefix="/api/connectors", tags=["connectors"])


class ConnectorIn(BaseModel):
    type: str = Field(max_length=50)
    name: str = Field(min_length=1, max_length=80)
    config: dict[str, str] = Field(default_factory=dict)
    secrets: dict[str, str] = Field(default_factory=dict)


class ConnectorPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    config: dict[str, str] | None = None
    # Solo se sustituyen los secretos enviados con valor; vacío = conservar.
    secrets: dict[str, str] | None = None


class EnableIn(BaseModel):
    enabled: bool


def _owned(ctx: AppContext, user: dict[str, Any], connector_id: int) -> dict[str, Any]:
    row = ctx.db.one("SELECT * FROM connectors WHERE id = ? AND owner_id = ?", (connector_id, user["id"]))
    if not row:
        raise HTTPException(404, "Conector no encontrado.")
    return row


def _split(cls, config: dict[str, str], secrets: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    """Solo se aceptan campos declarados y cada uno va a su sitio (público o secreto)."""
    pub, sec = {}, {}
    for spec in cls.type.fields:
        if spec.secret and secrets.get(spec.name, "").strip():
            sec[spec.name] = secrets[spec.name].strip()[:1000]
        elif not spec.secret and spec.name in config:
            pub[spec.name] = config[spec.name].strip()[:300]
    return pub, sec


def _status_for(ctx: AppContext, cls, config: dict[str, str], secrets: dict[str, str]) -> str:
    return "pending_config" if cls(config, secrets).missing_fields() else "untested"


@router.get("/types")
def types(user=Depends(current_user)):
    return [cls.type.as_dict() for cls in CONNECTOR_CLASSES.values()]


@router.get("")
def list_connectors(user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    rows = ctx.db.all("SELECT * FROM connectors WHERE owner_id = ? ORDER BY id", (user["id"],))
    return [public_connector(ctx, r) for r in rows]


@router.post("")
def create(body: ConnectorIn, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    cls = CONNECTOR_CLASSES.get(body.type)
    if not cls:
        raise HTTPException(400, "Tipo de conector desconocido.")
    config, secrets = _split(cls, body.config, body.secrets)
    errors = cls.validate(config, secrets)
    if errors:
        raise HTTPException(422, " ".join(errors))
    now = now_iso()
    cid = ctx.db.execute(
        "INSERT INTO connectors (owner_id, type, name, config_json, secret_enc, enabled, status,"
        " created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
        (
            user["id"],
            body.type,
            body.name,
            dumps(config),
            ctx.box.encrypt(secrets) if secrets else None,
            _status_for(ctx, cls, config, secrets),
            now,
            now,
        ),
    )
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        action="conector.crear",
        target=f"{body.type}:{body.name}",
    )
    return public_connector(ctx, _owned(ctx, user, cid))


@router.patch("/{connector_id}")
def update(
    connector_id: int, body: ConnectorPatch, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)
):
    row = _owned(ctx, user, connector_id)
    cls = CONNECTOR_CLASSES[row["type"]]
    config = loads(row["config_json"])
    secrets = ctx.box.decrypt(row["secret_enc"])
    new_config, new_secrets = _split(cls, body.config or {}, body.secrets or {})
    config.update(new_config)
    secrets.update(new_secrets)
    errors = cls.validate(config, secrets)
    if errors:
        raise HTTPException(422, " ".join(errors))
    changed = bool(new_config or new_secrets)
    ctx.db.execute(
        "UPDATE connectors SET name = ?, config_json = ?, secret_enc = ?, updated_at = ?"
        + (", status = ?, enabled = 0, last_error = NULL" if changed else "")
        + " WHERE id = ?",
        (
            body.name or row["name"],
            dumps(config),
            ctx.box.encrypt(secrets) if secrets else None,
            now_iso(),
            *((_status_for(ctx, cls, config, secrets),) if changed else ()),
            connector_id,
        ),
    )
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        action="conector.editar",
        target=row["name"],
        detail="credenciales/configuración cambiadas; requiere nueva prueba" if changed else "nombre",
    )
    return public_connector(ctx, _owned(ctx, user, connector_id))


@router.post("/{connector_id}/test")
async def test(connector_id: int, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    row = _owned(ctx, user, connector_id)
    connector = instantiate(ctx, row)
    missing = connector.missing_fields()
    if missing:
        message = "Pendiente de configuración: falta " + ", ".join(missing) + "."
        status, ok = "pending_config", False
    else:
        try:
            message = await connector.test()
            status, ok = "connected", True
        except ConnectorError as exc:
            message, status, ok = exc.message, "error", False
    ctx.db.execute(
        "UPDATE connectors SET status = ?, last_error = ?, last_tested_at = ?"
        + ("" if ok else ", enabled = 0")
        + " WHERE id = ?",
        (status, None if ok else message, now_iso(), connector_id),
    )
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        action="conector.probar",
        target=row["name"],
        result="ok" if ok else "error",
        detail=message,
    )
    return {"ok": ok, "message": message, "connector": public_connector(ctx, _owned(ctx, user, connector_id))}


@router.post("/{connector_id}/enable")
def enable(connector_id: int, body: EnableIn, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    row = _owned(ctx, user, connector_id)
    if body.enabled and row["status"] != "connected":
        raise HTTPException(
            409, "Solo se puede activar un conector cuya prueba de conexión haya sido correcta."
        )
    ctx.db.execute(
        "UPDATE connectors SET enabled = ?, updated_at = ? WHERE id = ?",
        (int(body.enabled), now_iso(), connector_id),
    )
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        action="conector.activar" if body.enabled else "conector.desactivar",
        target=row["name"],
    )
    return public_connector(ctx, _owned(ctx, user, connector_id))


@router.delete("/{connector_id}")
def disconnect(
    connector_id: int, confirm: bool = False, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)
):
    row = _owned(ctx, user, connector_id)
    if not confirm:
        raise HTTPException(428, "Desconectar borra las credenciales guardadas. Confirma la acción.")
    ctx.db.execute("DELETE FROM connectors WHERE id = ?", (connector_id,))
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        action="conector.desconectar",
        target=row["name"],
        detail="Credenciales eliminadas del servidor",
    )
    return {"ok": True}
