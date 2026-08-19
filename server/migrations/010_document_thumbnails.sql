-- The rendered first page is stored separately from the original PDF. The
-- nullable key lets ingestion continue when preview rendering is unavailable.
ALTER TABLE documents
  ADD COLUMN thumbnail_key TEXT;

CREATE UNIQUE INDEX documents_thumbnail_key_unique_idx
  ON documents (thumbnail_key)
  WHERE thumbnail_key IS NOT NULL;
