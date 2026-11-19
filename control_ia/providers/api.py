"""Endpoints de proveedores: estado, credenciales, prueba de conexión y modelos."""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import audit
from ..auth import current_user, require_admin
from ..context import AppContext, get_ctx
from ..db import now_iso
from ..security import redact
from . import PROVIDER_CLASSES, ProviderError, available_provider_ids, get_provider, key_source

router = APIRouter(prefix="/api/providers", tags=["providers"])

_models_cache: dict[str, tuple[float, list[str]]] = {}
MODELS_TTL = 600


class KeyIn(BaseModel):
    api_key: str = Field(min_length=8, max_length=500)


def _status_row(ctx: AppContext, provider_id: str) -> dict[str, Any]:
    row = ctx.db.one("SELECT * FROM provider_settings WHERE provider_id = ?", (provider_id,)) or {}
    provider = get_provider(ctx, provider_id)
    problem = provider.configuration_problem()
    return {
        "id": provider_id,
        "name": provider.name,
        "description": provider.description,
        "requires_key": provider.requires_key,
        "key_env_var": provider.key_env_var,
        "key_help": provider.key_help,
        "supports_tools": provider.supports_tools,
        "is_demo": provider.is_demo,
        "key_source": key_source(ctx, provider_id),
        "configured": problem is None,
        "problem": problem,
        # Estado de la última prueba real: 'ok', 'error' o 'unknown' (nunca probado).
        "status": row.get("status", "unknown"),
        "last_error": row.get("last_error"),
        "last_tested_at": row.get("last_tested_at"),
        "last_used_at": row.get("last_used_at"),
    }


def _upsert(ctx: AppContext, provider_id: str, **fields: Any) -> None:
    ctx.db.execute("INSERT OR IGNORE INTO provider_settings (provider_id) VALUES (?)", (provider_id,))
    sets = ", ".join(f"{k} = ?" for k in fields)
    ctx.db.execute(
        f"UPDATE provider_settings SET {sets} WHERE provider_id = ?", (*fields.values(), provider_id)
    )


def mark_used(ctx: AppContext, provider_id: str) -> None:
    _upsert(ctx, provider_id, last_used_at=now_iso())


def _check_id(ctx: AppContext, provider_id: str) -> None:
    if provider_id not in available_provider_ids(ctx):
        raise HTTPException(404, "Proveedor desconocido.")


@router.get("")
def list_providers(user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    return [_status_row(ctx, pid) for pid in available_provider_ids(ctx)]


@router.put("/{provider_id}/key")
def set_key(provider_id: str, body: KeyIn, admin=Depends(require_admin), ctx: AppContext = Depends(get_ctx)):
    _check_id(ctx, provider_id)
    if not PROVIDER_CLASSES[provider_id].requires_key:
        raise HTTPException(400, "Este proveedor no usa API key.")
    _upsert(
        ctx,
        provider_id,
        secret_enc=ctx.box.encrypt({"api_key": body.api_key.strip()}),
        status="unknown",
        last_error=None,
        updated_by=admin["email"],
        updated_at=now_iso(),
    )
    _models_cache.pop(provider_id, None)
    audit.record(
        ctx.db,
        actor=admin["email"],
        user_id=admin["id"],
        action="proveedor.guardar_credencial",
        target=provider_id,
    )
    return _status_row(ctx, provider_id)


@router.delete("/{provider_id}/key")
def delete_key(provider_id: str, admin=Depends(require_admin), ctx: AppContext = Depends(get_ctx)):
    _check_id(ctx, provider_id)
    _upsert(
        ctx,
        provider_id,
        secret_enc=None,
        status="unknown",
        last_error=None,
        updated_by=admin["email"],
        updated_at=now_iso(),
    )
    _models_cache.pop(provider_id, None)
    audit.record(
        ctx.db,
        actor=admin["email"],
        user_id=admin["id"],
        action="proveedor.borrar_credencial",
        target=provider_id,
    )
    return _status_row(ctx, provider_id)


@router.post("/{provider_id}/test")
async def test_provider(provider_id: str, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    _check_id(ctx, provider_id)
    provider = get_provider(ctx, provider_id)
    try:
        provider.ensure_configured()
        message = await provider.test()
        _upsert(ctx, provider_id, status="ok", last_error=None, last_tested_at=now_iso())
        result = "ok"
    except ProviderError as exc:
        message = redact(exc.message)
        _upsert(ctx, provider_id, status="error", last_error=message, last_tested_at=now_iso())
        result = "error"
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        action="proveedor.probar",
        target=provider_id,
        result=result,
        detail=message,
    )
    return {"ok": result == "ok", "message": message, "provider": _status_row(ctx, provider_id)}


@router.get("/{provider_id}/models")
async def models(
    provider_id: str, model: str = "", user=Depends(current_user), ctx: AppContext = Depends(get_ctx)
):
    _check_id(ctx, provider_id)
    provider = get_provider(ctx, provider_id)
    verified = False
    warning = None
    cached = _models_cache.get(provider_id)
    if cached and time.monotonic() - cached[0] < MODELS_TTL:
        names, verified = cached[1], True
    elif provider.configuration_problem():
        names = provider.suggested_models()
        warning = provider.configuration_problem()
    else:
        try:
            names = await provider.list_models()
            verified = True
            _models_cache[provider_id] = (time.monotonic(), names)
        except ProviderError as exc:
            names = provider.suggested_models()
            warning = f"No se pudo consultar la lista real de modelos: {redact(exc.message)}"
    params = [p.as_dict() for p in provider.params_for(model)] if model else []
    return {"models": names, "verified": verified, "warning": warning, "params": params}
