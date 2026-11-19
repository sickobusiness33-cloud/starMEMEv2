-- Kairo: orquestador multiagente, estudio de imágenes, ajustes de IA por usuario y notificaciones.

-- Chat: modo automático por defecto y configuración manual opcional.
ALTER TABLE chat_threads ADD COLUMN auto_mode INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chat_threads ADD COLUMN manual_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE chat_messages ADD COLUMN run_id INTEGER;
ALTER TABLE chat_messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';

-- Una ejecución del orquestador por mensaje del usuario.
CREATE TABLE chat_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    status TEXT NOT NULL,          -- queued | planning | running | aggregating | completed | failed | cancelled
    mode TEXT NOT NULL,            -- auto | manual
    plan_json TEXT NOT NULL DEFAULT '{}',
    notices_json TEXT NOT NULL DEFAULT '[]',
    result_message_id INTEGER,
    error TEXT,
    version INTEGER NOT NULL DEFAULT 0, -- sube con cada cambio: el stream SSE solo envía si cambia
    plan TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);

-- Estado real de cada agente dentro de una ejecución (lo que ve el Activity Panel).
CREATE TABLE chat_run_agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
    step TEXT NOT NULL,            -- id del paso en el plan (s1, s2…)
    agent_id TEXT NOT NULL,
    task TEXT NOT NULL,
    depends_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,          -- IDLE | QUEUED | ANALYZING | THINKING | SEARCHING | PROCESSING | GENERATING | EXECUTING | COMPLETED | ERROR
    action TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    model TEXT,
    fallback INTEGER NOT NULL DEFAULT 0,
    confidence REAL,
    result TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT,
    finished_at TEXT,
    execution_ms INTEGER
);

-- Imágenes generadas, editadas o subidas (estudio de imágenes y agentes).
CREATE TABLE images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,            -- t2i | i2i | inpaint | variation | upscale | upload
    prompt TEXT NOT NULL DEFAULT '',
    negative TEXT NOT NULL DEFAULT '',
    style TEXT,
    model TEXT,
    width INTEGER,
    height INTEGER,
    seed INTEGER,
    parent_id INTEGER,
    mime TEXT NOT NULL,
    data_b64 TEXT NOT NULL,
    size INTEGER NOT NULL,
    saved INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'studio', -- studio | agent | chat
    latency_ms INTEGER,
    created_at TEXT NOT NULL
);

-- Preferencias de IA por usuario: usar su API y orden de prioridad.
CREATE TABLE user_ai_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    use_my_api INTEGER NOT NULL DEFAULT 0,
    priority_json TEXT NOT NULL DEFAULT '["platform","user_api","free"]',
    updated_at TEXT NOT NULL
);

-- Centro de notificaciones.
CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,        -- ia | sistema | seguridad | cuenta | suscripcion | alertas
    priority TEXT NOT NULL DEFAULT 'normal', -- low | normal | high
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    link TEXT,
    dedupe_key TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE notification_prefs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    in_app INTEGER NOT NULL DEFAULT 1,
    browser INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, category)
);

CREATE INDEX idx_chat_runs_thread ON chat_runs(thread_id, id DESC);
CREATE INDEX idx_chat_run_agents_run ON chat_run_agents(run_id);
CREATE INDEX idx_images_user ON images(user_id, id DESC);
CREATE INDEX idx_notifications_user ON notifications(user_id, id DESC);
CREATE INDEX idx_notifications_dedupe ON notifications(user_id, dedupe_key);

-- Imágenes adjuntas a una ejecución del Agent Hub (agentes de edición y visión).
ALTER TABLE agent_runs ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';
