-- IA principal de la fábrica por usuario (también en tiempo de ejecución: src/factory/schema.ts).
ALTER TABLE fx_settings ADD COLUMN ai_default TEXT NOT NULL DEFAULT 'claude';
