"""Registro de auditoría: quién hizo qué, cuándo y con qué resultado.

Todo lo que se guarda pasa por `redact`, así que aunque un detalle incluya
por error un token, no queda en la base de datos.
"""

from __future__ import annotations

import logging
from typing import Any

from .db import Database, now_iso
from .security import redact

logger = logging.getLogger(__name__)


def record(
    db: Database,
    *,
    actor: str,
    action: str,
    result: str = "ok",
    user_id: int | None = None,
    project_id: int | None = None,
    target: str | None = None,
    detail: str | None = None,
) -> None:
    db.execute(
        "INSERT INTO audit_log (ts, user_id, actor, project_id, action, target, result, detail)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            now_iso(),
            user_id,
            redact(actor)[:200],
            project_id,
            action,
            redact(target)[:300] if target else None,
            result,
            redact(detail)[:2000] if detail else None,
        ),
    )
    logger.info("auditoría: %s %s %s (%s)", actor, action, target or "", result)


def list_entries(
    db: Database,
    *,
    user: dict[str, Any],
    project_id: int | None = None,
    query: str = "",
    result: str = "",
    limit: int = 200,
) -> list[dict[str, Any]]:
    where = []
    params: list[Any] = []
    if user["role"] != "admin":
        # Un miembro ve sus propias acciones y las de sus proyectos.
        where.append("(a.user_id = ? OR a.project_id IN (SELECT id FROM projects WHERE owner_id = ?))")
        params += [user["id"], user["id"]]
    if project_id:
        where.append("a.project_id = ?")
        params.append(project_id)
    if query:
        where.append("(a.action LIKE ? OR a.target LIKE ? OR a.detail LIKE ? OR a.actor LIKE ?)")
        params += [f"%{query}%"] * 4
    if result:
        where.append("a.result = ?")
        params.append(result)
    sql = "SELECT a.*, p.name AS project_name FROM audit_log a LEFT JOIN projects p ON p.id = a.project_id"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY a.id DESC LIMIT ?"
    params.append(max(1, min(limit, 500)))
    return db.all(sql, params)
