-- Plataforma: suscripciones Free/Pro, chat central, Agent Hub, métricas y salud de proveedores.

-- Suscripción por usuario. Sin fila = FREE.
CREATE TABLE subscriptions (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
    subscription_status TEXT NOT NULL DEFAULT 'none', -- none | active | trialing | past_due | canceled | manual
    renewal_date TEXT,
    provider TEXT,            -- none | manual | stripe | …
    customer_id TEXT,
    external_subscription_id TEXT,
    updated_at TEXT NOT NULL
);

-- Chat central (fuera de proyectos).
CREATE TABLE chat_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'auto', -- auto | claude | free | agent:<id>
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    fallback INTEGER NOT NULL DEFAULT 0,
    notice TEXT,
    agent_id TEXT,
    created_at TEXT NOT NULL
);

-- Ejecuciones de agentes del Agent Hub.
CREATE TABLE agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL,                 -- pending | running | completed | failed | cancelled
    stage TEXT,
    stages_json TEXT NOT NULL DEFAULT '[]',
    input TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '',
    output_kind TEXT NOT NULL DEFAULT 'text', -- text | image
    error TEXT,
    notices_json TEXT NOT NULL DEFAULT '[]',
    plan TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);

-- Métricas reales de cada llamada a un modelo (nunca inventadas).
CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    plan TEXT NOT NULL,
    kind TEXT NOT NULL,          -- chat | agent | project
    agent_id TEXT,
    agent_run_id INTEGER,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    fallback INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL,
    error TEXT,
    latency_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    tokens_estimated INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

-- Salud de proveedores: si Claude se queda sin créditos se marca un enfriamiento
-- y el router usa el respaldo; al expirar vuelve a intentarlo solo.
CREATE TABLE provider_health (
    provider TEXT PRIMARY KEY,
    available_after TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
);

-- Agentes añadidos después (manifiestos) con su pipeline de validación.
CREATE TABLE hub_agents (
    id TEXT PRIMARY KEY,
    manifest_json TEXT NOT NULL,
    status TEXT NOT NULL,        -- validated | available | rejected | disabled
    validation_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Fuentes open source (repositorios). Solo se guarda metadatos y el resultado
-- de la comprobación de licencia; nunca se descarga ni ejecuta su código.
CREATE TABLE hub_sources (
    repo TEXT PRIMARY KEY COLLATE NOCASE,
    found_in TEXT,
    section TEXT,
    license TEXT,
    license_status TEXT NOT NULL DEFAULT 'pending', -- pending | compatible | restricted | incompatible | unverifiable
    license_flags TEXT,
    checked_at TEXT,
    notes TEXT
);

CREATE INDEX idx_agent_runs_user ON agent_runs(user_id, id DESC);
CREATE INDEX idx_usage_created ON usage_events(created_at);
CREATE INDEX idx_usage_user ON usage_events(user_id, created_at);
CREATE INDEX idx_usage_agent ON usage_events(agent_id);
CREATE INDEX idx_chat_threads_user ON chat_threads(user_id, updated_at DESC);
CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, id);
CREATE INDEX idx_sources_status ON hub_sources(license_status);
