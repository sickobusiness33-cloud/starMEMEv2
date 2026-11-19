-- Kairo Autopilot: objetivos, tareas, eventos (decisiones/herramientas/errores) y memoria persistente.

CREATE TABLE ap_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',        -- active | paused | done
    cadence_minutes INTEGER NOT NULL DEFAULT 60,  -- cada cuánto se abre un ciclo nuevo
    max_tasks_per_cycle INTEGER NOT NULL DEFAULT 3,
    max_cycles_per_day INTEGER NOT NULL DEFAULT 12,
    token_budget_day INTEGER NOT NULL DEFAULT 60000,
    cycles INTEGER NOT NULL DEFAULT 0,
    last_cycle_at TEXT,
    next_cycle_at TEXT,
    paused_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_ap_goals_due ON ap_goals(status, next_cycle_at);
CREATE INDEX idx_ap_goals_user ON ap_goals(user_id);

CREATE TABLE ap_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL REFERENCES ap_goals(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    cycle INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,                           -- rol del agente (backend, testing, ...)
    status TEXT NOT NULL DEFAULT 'pending',       -- pending | queued | running | review | done | failed | needs_approval | waiting | blocked | cancelled
    risk TEXT NOT NULL DEFAULT 'low',             -- low | medium | high | critical
    depends_json TEXT NOT NULL DEFAULT '[]',
    dedupe_key TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 2,
    escalated INTEGER NOT NULL DEFAULT 0,
    action_json TEXT,                             -- acción de alto riesgo pendiente de aprobación
    last_action TEXT,
    result TEXT,
    error TEXT,
    feedback TEXT,
    provider TEXT,
    model TEXT,
    lease_until TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (goal_id, dedupe_key)
);
CREATE INDEX idx_ap_tasks_goal ON ap_tasks(goal_id, status);
CREATE INDEX idx_ap_tasks_user ON ap_tasks(user_id, status);

CREATE TABLE ap_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    goal_id INTEGER,
    task_id INTEGER,
    kind TEXT NOT NULL,                           -- cycle | decision | delegate | tool | result | review | retry | escalate | approval | error | memory | limit
    agent TEXT NOT NULL,                          -- rol que lo produce
    target TEXT,                                  -- rol al que delega (Mission Control)
    message TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX idx_ap_events_user ON ap_events(user_id, id DESC);
CREATE INDEX idx_ap_events_goal ON ap_events(goal_id, id DESC);

CREATE TABLE ap_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    goal_id INTEGER REFERENCES ap_goals(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                           -- context | decision | result | error | solution | knowledge
    content TEXT NOT NULL,
    source_task_id INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_ap_memory_goal ON ap_memory(goal_id, id DESC);
