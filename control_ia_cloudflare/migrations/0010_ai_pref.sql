-- IA elegida por misión y por proyecto (también se crea en tiempo de ejecución, ver src/factory/schema.ts).
ALTER TABLE fx_projects ADD COLUMN ai_pref TEXT;
ALTER TABLE fx_missions ADD COLUMN ai_pref TEXT;
