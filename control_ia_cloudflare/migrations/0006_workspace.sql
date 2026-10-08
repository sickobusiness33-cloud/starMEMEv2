-- AI Agent OS: proyectos como espacios de trabajo, memoria, eventos de ejecución y preferencias.

-- Proyectos: objetivo y plantilla (proveedor/modelo pasan a ser opcionales: por defecto AUTO).
ALTER TABLE projects ADD COLUMN objective TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN template TEXT NOT NULL DEFAULT 'custom';

-- Las conversaciones de Kairo pueden pertenecer a un proyecto.
ALTER TABLE chat_threads ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX idx_chat_threads_project ON chat_threads(project_id, updated_at DESC);

-- Memoria persistente del proyecto (la usa el orquestador automáticamente).
CREATE TABLE project_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,            -- objective | instruction | preference | decision | fact
    content TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'user', -- user | kairo
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_project_memory ON project_memory(project_id, id);

-- Por qué se eligió cada agente y su rol visual.
ALTER TABLE chat_run_agents ADD COLUMN why TEXT;
ALTER TABLE chat_run_agents ADD COLUMN role TEXT;
ALTER TABLE chat_runs ADD COLUMN task_type TEXT;
ALTER TABLE chat_runs ADD COLUMN project_id INTEGER;
CREATE INDEX idx_chat_runs_project ON chat_runs(project_id, id DESC);

-- Eventos de ejecución (fuente única para red de agentes, timeline, Mission Control y replay).
CREATE TABLE run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    ms INTEGER NOT NULL,           -- milisegundos desde el inicio de la ejecución (para el replay)
    type TEXT NOT NULL,            -- RUN_* | PLAN_CREATED | TASK_* | AGENT_* | VALIDATION_*
    step TEXT,
    agent_id TEXT,
    status TEXT,
    action TEXT,
    progress INTEGER,
    data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_run_events_run ON run_events(run_id, id);

-- Preferencias de interfaz del usuario (tema, dashboard, visuales de agentes).
CREATE TABLE user_prefs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);
