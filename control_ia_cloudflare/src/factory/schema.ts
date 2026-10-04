// Esquema de la Autonomous Project Factory. Se crea en tiempo de ejecución (IF NOT EXISTS) para no
// depender de permisos de D1 en el token de despliegue; migrations/0008_factory.sql es idéntico.

export const FACTORY_SQL = [
  `CREATE TABLE IF NOT EXISTS fx_settings (
    user_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    daily_target INTEGER NOT NULL DEFAULT 10,
    max_parallel INTEGER NOT NULL DEFAULT 3,
    token_budget_day INTEGER NOT NULL DEFAULT 400000,
    niches_json TEXT NOT NULL DEFAULT '[]',
    auto_ideas INTEGER NOT NULL DEFAULT 1,
    github_connector_id INTEGER,
    theme TEXT NOT NULL DEFAULT 'cobalt',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fx_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    niche TEXT NOT NULL,
    idea TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'backlog',
    status TEXT NOT NULL DEFAULT 'queued',
    priority INTEGER NOT NULL DEFAULT 5,
    attempts INTEGER NOT NULL DEFAULT 0,
    research_json TEXT NOT NULL DEFAULT '{}',
    spec_json TEXT NOT NULL DEFAULT '{}',
    checks_json TEXT NOT NULL DEFAULT '{}',
    apis_json TEXT NOT NULL DEFAULT '[]',
    stack TEXT NOT NULL DEFAULT 'Cloudflare Workers · HTML/CSS · Kairo FX runtime',
    html TEXT,
    prev_html TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    url TEXT,
    repo TEXT,
    feedback TEXT,
    errors TEXT,
    lease_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    live_at TEXT,
    last_audit_at TEXT,
    UNIQUE (user_id, dedupe_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fx_projects_user ON fx_projects(user_id, stage)`,
  `CREATE INDEX IF NOT EXISTS idx_fx_projects_stage ON fx_projects(stage, status)`,
  `CREATE TABLE IF NOT EXISTS fx_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    project_id INTEGER,
    stage TEXT NOT NULL,
    agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fx_events_user ON fx_events(user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_fx_events_project ON fx_events(project_id, id DESC)`,
];

let ready: Promise<void> | null = null;
/** Crea las tablas una vez por isolate (barato: IF NOT EXISTS en un batch). */
export function ensureFactorySchema(db: D1Database): Promise<void> {
  if (!ready) ready = db.batch(FACTORY_SQL.map((s) => db.prepare(s))).then(() => undefined).catch((e) => { ready = null; throw e; });
  return ready;
}
