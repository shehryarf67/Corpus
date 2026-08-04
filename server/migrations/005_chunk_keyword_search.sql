-- Store Postgres' searchable representation of each chunk's content.
-- Because this is a generated column, existing rows are populated by the
-- migration and future inserts do not need to provide search_vector.
ALTER TABLE chunks
  ADD COLUMN search_vector TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

-- A GIN index maps normalized words to matching chunk rows, avoiding a full
-- table scan for every keyword search.
CREATE INDEX chunks_search_vector_gin_idx
  ON chunks
  USING GIN (search_vector);
