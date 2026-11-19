-- Misiones de la fábrica (órdenes permanentes diarias) y logos generados. Idéntico a src/factory/schema.ts.
CREATE TABLE IF NOT EXISTS fx_missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'website',
  niche TEXT NOT NULL DEFAULT 'other',
  per_day INTEGER NOT NULL DEFAULT 10,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fx_missions_user ON fx_missions(user_id, active);
CREATE TABLE IF NOT EXISTS fx_assets (
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  data_b64 TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, name)
);
ALTER TABLE fx_projects ADD COLUMN mission_id INTEGER;
ALTER TABLE fx_projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'website';
CREATE INDEX IF NOT EXISTS idx_fx_projects_mission ON fx_projects(mission_id, created_at);
