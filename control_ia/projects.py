"""Proyectos: CRUD, archivos, herramientas, conectores vinculados y conversaciones.

Cada proyecto pertenece a un usuario y todo lo que cuelga de él (archivos,
conversaciones, ejecuciones, herramientas, vínculos a conectores) se consulta
siempre filtrando por `project_id`, así que los historiales no se mezclan.
"""

from __future__ import annotations

import os
import re
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import audit
from .auth import current_user
from .context import AppContext, get_ctx
from .db import dumps, loads, now_iso
from .providers import ProviderError, available_provider_ids, get_provider
from .tools import TOOLS, tool_status

router = APIRouter(prefix="/api/projects", tags=["projects"])

COLORS = ["azul", "rosa", "morado", "verde", "turquesa", "naranja"]
DEFAULT_LIMITS = {"max_runs_per_day": 100, "history_messages": 20, "max_tool_steps": 6}
ALLOWED_EXTENSIONS = {
    ".txt",
    ".md",
    ".json",
    ".csv",
    ".tsv",
    ".py",
    ".js",
    ".ts",
    ".html",
    ".css",
    ".yaml",
    ".yml",
    ".xml",
    ".log",
    ".toml",
    ".ini",
    ".sql",
    ".sh",
}


class Limits(BaseModel):
    max_runs_per_day: int = Field(default=100, ge=1, le=10_000)
    history_messages: int = Field(default=20, ge=0, le=200)
    max_tool_steps: int = Field(default=6, ge=1, le=25)


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    instructions: str = Field(default="", max_length=20_000)
    color: str = Field(default="azul", pattern="^(" + "|".join(COLORS) + ")$")
    provider: str = Field(default="", max_length=40)
    model: str = Field(default="", max_length=120)
    params: dict[str, Any] = Field(default_factory=dict)
    limits: Limits = Field(default_factory=Limits)


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    instructions: str | None = Field(default=None, max_length=20_000)
    color: str | None = Field(default=None, pattern="^(" + "|".join(COLORS) + ")$")
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=120)
    params: dict[str, Any] | None = None
    limits: Limits | None = None
    status: str | None = Field(default=None, pattern="^(active|archived)$")


class ToggleIn(BaseModel):
    enabled: bool


class LinkIn(BaseModel):
    linked: bool


class FilePatch(BaseModel):
    include_in_context: bool


class ConversationIn(BaseModel):
    title: str = Field(default="Nueva conversación", min_length=1, max_length=120)


def project_out(ctx: AppContext, row: dict[str, Any]) -> dict[str, Any]:
    stats = ctx.db.one(
        "SELECT COUNT(*) AS runs, SUM(status IN ('pending','running','awaiting_confirmation')) AS active,"
        " MAX(created_at) AS last_run FROM runs WHERE project_id = ?",
        (row["id"],),
    )
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "instructions": row["instructions"],
        "color": row["color"],
        "status": row["status"],
        "provider": row["provider"],
        "model": row["model"],
        "params": loads(row["params_json"]),
        "limits": {**DEFAULT_LIMITS, **loads(row["limits_json"])},
        "is_demo": bool(row["is_demo"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "run_count": stats["runs"] or 0,
        "active_runs": stats["active"] or 0,
        "last_run_at": stats["last_run"],
        "file_count": ctx.db.one(
            "SELECT COUNT(*) AS n FROM project_files WHERE project_id = ?", (row["id"],)
        )["n"],
        "tool_count": ctx.db.one(
            "SELECT COUNT(*) AS n FROM project_tools WHERE project_id = ?", (row["id"],)
        )["n"],
    }


def get_project(ctx: AppContext, user: dict[str, Any], project_id: int) -> dict[str, Any]:
    row = ctx.db.one("SELECT * FROM projects WHERE id = ? AND owner_id = ?", (project_id, user["id"]))
    if not row:
        raise HTTPException(404, "Proyecto no encontrado.")
    return row


def _validate_ai(ctx: AppContext, provider_id: str, model: str, params: dict[str, Any]) -> dict[str, Any]:
    if not provider_id:
        return {}
    if provider_id not in available_provider_ids(ctx):
        raise HTTPException(422, f"Proveedor desconocido: {provider_id}.")
    try:
        return get_provider(ctx, provider_id).clean_params(model, params)
    except (ProviderError, ValueError, TypeError) as exc:
        raise HTTPException(422, getattr(exc, "message", "Parámetros no válidos.")) from exc


@router.get("")
def list_projects(
    q: str = "", status: str = "active", user=Depends(current_user), ctx: AppContext = Depends(get_ctx)
):
    sql = "SELECT * FROM projects WHERE owner_id = ?"
    params: list[Any] = [user["id"]]
    if status in {"active", "archived"}:
        sql += " AND status = ?"
        params.append(status)
    if q:
        sql += " AND (name LIKE ? OR description LIKE ?)"
        params += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY updated_at DESC"
    return [project_out(ctx, r) for r in ctx.db.all(sql, params)]


@router.post("")
def create_project(body: ProjectIn, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    params = _validate_ai(ctx, body.provider, body.model, body.params)
    now = now_iso()
    pid = ctx.db.execute(
        "INSERT INTO projects (owner_id, name, description, instructions, color, provider, model,"
        " params_json, limits_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            user["id"],
            body.name.strip(),
            body.description,
            body.instructions,
            body.color,
            body.provider,
            body.model.strip(),
            dumps(params),
            dumps(body.limits.model_dump()),
            now,
            now,
        ),
    )
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        project_id=pid,
        action="proyecto.crear",
        target=body.name,
    )
    return project_out(ctx, get_project(ctx, user, pid))


@router.get("/{project_id}")
def read_project(project_id: int, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    return project_out(ctx, get_project(ctx, user, project_id))


@router.patch("/{project_id}")
def update_project(
    project_id: int, body: ProjectPatch, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)
):
    row = get_project(ctx, user, project_id)
    data = body.model_dump(exclude_none=True)
    provider = data.get("provider", row["provider"])
    model = data.get("model", row["model"])
    if {"provider", "model", "params"} & data.keys():
        params = data.get("params", loads(row["params_json"]))
        data["params"] = _validate_ai(ctx, provider, model, params)
    fields: dict[str, Any] = {}
    for key in ("name", "description", "instructions", "color", "provider", "model", "status"):
        if key in data:
            fields[key] = (
                data[key].strip() if isinstance(data[key], str) and key in {"name", "model"} else data[key]
            )
    if "params" in data:
        fields["params_json"] = dumps(data["params"])
    if "limits" in data:
        fields["limits_json"] = dumps(data["limits"])
    if not fields:
        return project_out(ctx, row)
    fields["updated_at"] = now_iso()
    ctx.db.execute(
        f"UPDATE projects SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
        (*fields.values(), project_id),
    )
    if "status" in data and data["status"] != row["status"]:
        action = "proyecto.archivar" if data["status"] == "archived" else "proyecto.restaurar"
    else:
        action = "proyecto.editar"
    changed = ", ".join(k for k in data)
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        project_id=project_id,
        action=action,
        target=row["name"],
        detail=f"campos: {changed}",
    )
    return project_out(ctx, get_project(ctx, user, project_id))


@router.delete("/{project_id}")
async def delete_project(
    project_id: int, confirm: bool = False, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)
):
    row = get_project(ctx, user, project_id)
    if not confirm:
        raise HTTPException(
            428, "Eliminar un proyecto borra su historial, archivos y ejecuciones. Confirma la acción."
        )
    if ctx.runs:
        await ctx.runs.cancel_project(project_id)
    ctx.db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        action="proyecto.eliminar",
        target=row["name"],
        detail=f"id={project_id}",
    )
    return {"ok": True}


# --- Archivos --------------------------------------------------------------


def _file_out(row: dict[str, Any]) -> dict[str, Any]:
    return {k: row[k] for k in ("id", "name", "size", "created_by", "created_at")} | {
        "include_in_context": bool(row["include_in_context"])
    }


@router.get("/{project_id}/files")
def list_files(project_id: int, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    get_project(ctx, user, project_id)
    return [
        _file_out(r)
        for r in ctx.db.all(
            "SELECT id, name, size, include_in_context, created_by, created_at FROM project_files"
            " WHERE project_id = ? ORDER BY name",
            (project_id,),
        )
    ]


@router.post("/{project_id}/files")
async def upload_file(
    project_id: int,
    file: UploadFile = File(...),
    user=Depends(current_user),
    ctx: AppContext = Depends(get_ctx),
):
    get_project(ctx, user, project_id)
    name = os.path.basename(file.filename or "").strip()
    if not re.fullmatch(r"[\w\-. ]{1,120}", name):
        raise HTTPException(422, "Nombre de archivo no válido (usa letras, números, espacios, - _ .).")
    if os.path.splitext(name)[1].lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            422, "Tipo no admitido. Solo archivos de texto: " + ", ".join(sorted(ALLOWED_EXTENSIONS))
        )
    raw = await file.read(ctx.settings.max_file_bytes + 1)
    if len(raw) > ctx.settings.max_file_bytes:
        raise HTTPException(413, f"El archivo supera el máximo de {ctx.settings.max_file_bytes // 1024} KB.")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(422, "El archivo no es texto UTF-8.") from exc
    if ctx.db.one("SELECT id FROM project_files WHERE project_id = ? AND name = ?", (project_id, name)):
        raise HTTPException(409, "Ya existe un archivo con ese nombre en el proyecto.")
    fid = ctx.db.execute(
        "INSERT INTO project_files (project_id, name, content, size, include_in_context, created_by,"
        " created_at)"
        " VALUES (?, ?, ?, ?, 0, ?, ?)",
        (project_id, name, content, len(raw), user["email"], now_iso()),
    )
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        project_id=project_id,
        action="archivo.subir",
        target=name,
        detail=f"{len(raw)} bytes",
    )
    return _file_out(ctx.db.one("SELECT * FROM project_files WHERE id = ?", (fid,)))


def _get_file(ctx: AppContext, project_id: int, file_id: int) -> dict[str, Any]:
    row = ctx.db.one("SELECT * FROM project_files WHERE id = ? AND project_id = ?", (file_id, project_id))
    if not row:
        raise HTTPException(404, "Archivo no encontrado.")
    return row


@router.patch("/{project_id}/files/{file_id}")
def patch_file(
    project_id: int,
    file_id: int,
    body: FilePatch,
    user=Depends(current_user),
    ctx: AppContext = Depends(get_ctx),
):
    get_project(ctx, user, project_id)
    _get_file(ctx, project_id, file_id)
    ctx.db.execute(
        "UPDATE project_files SET include_in_context = ? WHERE id = ?",
        (int(body.include_in_context), file_id),
    )
    return _file_out(_get_file(ctx, project_id, file_id))


@router.get("/{project_id}/files/{file_id}/download")
def download_file(
    project_id: int, file_id: int, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)
):
    get_project(ctx, user, project_id)
    row = _get_file(ctx, project_id, file_id)
    # Siempre como adjunto de texto plano: nunca se interpreta como HTML.
    return Response(
        row["content"],
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{row["name"]}"'},
    )


@router.delete("/{project_id}/files/{file_id}")
def delete_file(
    project_id: int,
    file_id: int,
    confirm: bool = False,
    user=Depends(current_user),
    ctx: AppContext = Depends(get_ctx),
):
    get_project(ctx, user, project_id)
    row = _get_file(ctx, project_id, file_id)
    if not confirm:
        raise HTTPException(428, "Eliminar un archivo es irreversible. Confirma la acción.")
    ctx.db.execute("DELETE FROM project_files WHERE id = ?", (file_id,))
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        project_id=project_id,
        action="archivo.eliminar",
        target=row["name"],
    )
    return {"ok": True}


# --- Herramientas y conectores del proyecto ------------------------------


@router.get("/{project_id}/tools")
def project_tools(project_id: int, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    return tool_status(ctx, get_project(ctx, user, project_id))


@router.put("/{project_id}/tools/{tool_id}")
def toggle_tool(
    project_id: int,
    tool_id: str,
    body: ToggleIn,
    user=Depends(current_user),
    ctx: AppContext = Depends(get_ctx),
):
    project = get_project(ctx, user, project_id)
    if tool_id not in TOOLS:
        raise HTTPException(404, "Herramienta desconocida.")
    if body.enabled:
        ctx.db.execute(
            "INSERT OR IGNORE INTO project_tools (project_id, tool_id) VALUES (?, ?)", (project_id, tool_id)
        )
    else:
        ctx.db.execute(
            "DELETE FROM project_tools WHERE project_id = ? AND tool_id = ?", (project_id, tool_id)
        )
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        project_id=project_id,
        action="herramienta.habilitar" if body.enabled else "herramienta.deshabilitar",
        target=tool_id,
    )
    return tool_status(ctx, project)


@router.get("/{project_id}/connectors")
def project_connectors(project_id: int, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    get_project(ctx, user, project_id)
    rows = ctx.db.all(
        "SELECT c.id, c.name, c.type, c.status, c.enabled,"
        " EXISTS(SELECT 1 FROM project_connectors pc"
        " WHERE pc.project_id = ? AND pc.connector_id = c.id) AS linked"
        " FROM connectors c WHERE c.owner_id = ? ORDER BY c.name",
        (project_id, user["id"]),
    )
    return [r | {"linked": bool(r["linked"]), "enabled": bool(r["enabled"])} for r in rows]


@router.put("/{project_id}/connectors/{connector_id}")
def link_connector(
    project_id: int,
    connector_id: int,
    body: LinkIn,
    user=Depends(current_user),
    ctx: AppContext = Depends(get_ctx),
):
    get_project(ctx, user, project_id)
    conn = ctx.db.one("SELECT * FROM connectors WHERE id = ? AND owner_id = ?", (connector_id, user["id"]))
    if not conn:
        raise HTTPException(404, "Conector no encontrado.")
    if body.linked:
        ctx.db.execute(
            "INSERT OR IGNORE INTO project_connectors (project_id, connector_id) VALUES (?, ?)",
            (project_id, connector_id),
        )
    else:
        ctx.db.execute(
            "DELETE FROM project_connectors WHERE project_id = ? AND connector_id = ?",
            (project_id, connector_id),
        )
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        project_id=project_id,
        action="conector.vincular" if body.linked else "conector.desvincular",
        target=conn["name"],
    )
    return project_connectors(project_id, user, ctx)


# --- Conversaciones --------------------------------------------------------


@router.get("/{project_id}/conversations")
def list_conversations(project_id: int, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    get_project(ctx, user, project_id)
    return ctx.db.all(
        "SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count"
        " FROM conversations c WHERE c.project_id = ? ORDER BY c.updated_at DESC",
        (project_id,),
    )


@router.post("/{project_id}/conversations")
def create_conversation(
    project_id: int, body: ConversationIn, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)
):
    get_project(ctx, user, project_id)
    now = now_iso()
    cid = ctx.db.execute(
        "INSERT INTO conversations (project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (project_id, body.title, now, now),
    )
    return ctx.db.one("SELECT *, 0 AS message_count FROM conversations WHERE id = ?", (cid,))


def get_conversation(ctx: AppContext, project_id: int, conversation_id: int) -> dict[str, Any]:
    row = ctx.db.one(
        "SELECT * FROM conversations WHERE id = ? AND project_id = ?", (conversation_id, project_id)
    )
    if not row:
        raise HTTPException(404, "Conversación no encontrada en este proyecto.")
    return row


@router.get("/{project_id}/conversations/{conversation_id}")
def conversation_detail(
    project_id: int, conversation_id: int, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)
):
    get_project(ctx, user, project_id)
    conv = get_conversation(ctx, project_id, conversation_id)
    messages = ctx.db.all("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id", (conversation_id,))
    return {"conversation": conv, "messages": messages}


@router.delete("/{project_id}/conversations/{conversation_id}")
async def delete_conversation(
    project_id: int,
    conversation_id: int,
    confirm: bool = False,
    user=Depends(current_user),
    ctx: AppContext = Depends(get_ctx),
):
    get_project(ctx, user, project_id)
    conv = get_conversation(ctx, project_id, conversation_id)
    if not confirm:
        raise HTTPException(
            428, "Eliminar la conversación borra sus mensajes y ejecuciones. Confirma la acción."
        )
    if ctx.runs:
        await ctx.runs.cancel_conversation(conversation_id)
    ctx.db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
    audit.record(
        ctx.db,
        actor=user["email"],
        user_id=user["id"],
        project_id=project_id,
        action="conversacion.eliminar",
        target=conv["title"],
    )
    return {"ok": True}


@router.get("/{project_id}/search")
def search(project_id: int, q: str, user=Depends(current_user), ctx: AppContext = Depends(get_ctx)):
    """Búsqueda en mensajes y ejecuciones de ESTE proyecto únicamente."""
    get_project(ctx, user, project_id)
    if len(q.strip()) < 2:
        raise HTTPException(422, "Escribe al menos 2 caracteres para buscar.")
    like = f"%{q.strip()}%"
    messages = ctx.db.all(
        "SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title AS conversation_title"
        " FROM messages m JOIN conversations c ON c.id = m.conversation_id"
        " WHERE m.project_id = ? AND m.content LIKE ? ORDER BY m.id DESC LIMIT 50",
        (project_id, like),
    )
    runs = ctx.db.all(
        "SELECT id, conversation_id, status, input, output, error, created_at FROM runs"
        " WHERE project_id = ? AND (input LIKE ? OR output LIKE ? OR error LIKE ?) ORDER BY id DESC LIMIT 50",
        (project_id, like, like, like),
    )
    return {"messages": messages, "runs": runs}
