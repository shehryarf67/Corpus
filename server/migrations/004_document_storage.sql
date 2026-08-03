ALTER TABLE documents
  ADD COLUMN storage_key TEXT;

CREATE UNIQUE INDEX documents_storage_key_unique_idx
  ON documents (storage_key)
  WHERE storage_key IS NOT NULL;
