-- Esquema inicial de Control IA en D1.

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_at TEXT NOT NULL
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- Claves de IA propias de cada usuario (BYOK), cifradas con AES-GCM.
CREATE TABLE user_provider_keys (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_error TEXT,
    last_tested_at TEXT,
    last_used_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, provider)
);

CREATE TABLE projects (
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

CREATE TABLE project_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    size INTEGER NOT NULL,
    include_in_context INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE project_tools (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool_id TEXT NOT NULL,
    PRIMARY KEY (project_id, tool_id)
);

CREATE TABLE connectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    secret_enc TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending_config',
    last_error TEXT,
    last_tested_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE project_connectors (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    connector_id INTEGER NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, connector_id)
);

CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id INTEGER,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE runs (
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

CREATE TABLE actions (
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

CREATE TABLE audit_log (
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

-- Límites de uso: cada isolate de Workers es efímero, así que se cuentan en D1.
CREATE TABLE rate_events (
    key TEXT NOT NULL,
    ts INTEGER NOT NULL
);

CREATE INDEX idx_runs_project ON runs(project_id, id DESC);
CREATE INDEX idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX idx_audit_ts ON audit_log(id DESC);
CREATE INDEX idx_rate ON rate_events(key, ts);
CREATE INDEX idx_sessions_user ON sessions(user_id);
