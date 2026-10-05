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
  // Misiones: órdenes permanentes («crea 10 meme coins al día») que se ejecutan solas cada día hasta que el dueño las para.
  `CREATE TABLE IF NOT EXISTS fx_missions (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fx_missions_user ON fx_missions(user_id, active)`,
  // Imágenes generadas (logos de las meme coins), servidas en /s/<slug>/logo.
  `CREATE TABLE IF NOT EXISTS fx_assets (
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    data_b64 TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, name)
  )`,
];

/** Columnas añadidas después de la primera versión (ALTER TABLE falla si ya existen: se ignora). */
const FACTORY_ALTERS = [
  "ALTER TABLE fx_projects ADD COLUMN mission_id INTEGER",
  "ALTER TABLE fx_projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'website'",
  // IA elegida (auto | claude | openai | gemini | groq | cloudflare): por misión y por proyecto, cambiable en cualquier momento.
  "ALTER TABLE fx_projects ADD COLUMN ai_pref TEXT",
  "ALTER TABLE fx_missions ADD COLUMN ai_pref TEXT",
];

let ready: Promise<void> | null = null;
/** Crea las tablas una vez por isolate (barato: IF NOT EXISTS en un batch). */
export function ensureFactorySchema(db: D1Database): Promise<void> {
  if (!ready) ready = db.batch(FACTORY_SQL.map((s) => db.prepare(s)))
    .then(async () => { for (const a of FACTORY_ALTERS) await db.prepare(a).run().catch(() => undefined); })
    .then(() => db.prepare("CREATE INDEX IF NOT EXISTS idx_fx_projects_mission ON fx_projects(mission_id, created_at)").run())
    .then(() => db.prepare("CREATE INDEX IF NOT EXISTS idx_usage_factory_run ON usage_events(kind, agent_run_id)").run().catch(() => undefined))
    .then(() => undefined).catch((e) => { ready = null; throw e; });
  return ready;
}
