-- Adjuntos en el chat: imágenes y PDF además de texto.
-- Los binarios se guardan en base64 (D1 admite filas de hasta 2 MB; el
-- servidor limita cada binario a 1 MB).

ALTER TABLE project_files ADD COLUMN mime TEXT NOT NULL DEFAULT 'text/plain';
ALTER TABLE project_files ADD COLUMN data_b64 TEXT;
ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
