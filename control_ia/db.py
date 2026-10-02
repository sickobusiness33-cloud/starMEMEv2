"""Acceso a SQLite.

Se abre una conexión por operación (`with db.connect() as conn`): SQLite lo
hace barato y así no compartimos conexiones entre el hilo del event loop y
los hilos del threadpool de FastAPI. WAL + busy_timeout evitan bloqueos en
escrituras concurrentes pequeñas, que es lo que hace esta app.
"""

from __future__ import annotations

import json
import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'azul',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    params_json TEXT NOT NULL DEFAULT '{}',
    limits_json TEXT NOT NULL DEFAULT '{}',
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    size INTEGER NOT NULL,
    include_in_context INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_tools (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool_id TEXT NOT NULL,
    PRIMARY KEY (project_id, tool_id)
);

CREATE TABLE IF NOT EXISTS connectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    secret_enc BLOB,
    enabled INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending_config',
    last_error TEXT,
    last_tested_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_connectors (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    connector_id INTEGER NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, connector_id)
);

CREATE TABLE IF NOT EXISTS provider_settings (
    provider_id TEXT PRIMARY KEY,
    secret_enc BLOB,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_error TEXT,
    last_tested_at TEXT,
    last_used_at TEXT,
    updated_by TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id INTEGER,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '',
    error TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    state_json TEXT NOT NULL DEFAULT '{}',
    usage_json TEXT NOT NULL DEFAULT '{}',
    steps INTEGER NOT NULL DEFAULT 0,
    retry_of INTEGER,
    user_message_id INTEGER,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id INTEGER,
    tool_id TEXT NOT NULL,
    args_json TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    decided_by TEXT,
    result TEXT,
    is_error INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    decided_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    user_id INTEGER,
    actor TEXT NOT NULL,
    project_id INTEGER,
    action TEXT NOT NULL,
    target TEXT,
    result TEXT NOT NULL,
    detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(id DESC);
"""


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def loads(value: str | None, default: Any = None) -> Any:
    if not value:
        return default if default is not None else {}
    return json.loads(value)


class Database:
    def __init__(self, path: str) -> None:
        self.path = path
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def one(self, sql: str, params: tuple | list = ()) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(sql, params).fetchone()
            return dict(row) if row else None

    def all(self, sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
        with self.connect() as conn:
            return [dict(r) for r in conn.execute(sql, params).fetchall()]

    def execute(self, sql: str, params: tuple | list = ()) -> int:
        """Ejecuta una escritura y devuelve lastrowid."""
        with self.connect() as conn:
            cur = conn.execute(sql, params)
            return int(cur.lastrowid or 0)
