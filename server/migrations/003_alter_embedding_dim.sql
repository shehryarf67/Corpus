-- Switching from Voyage's voyage-3 (1024-dim) to a local embedding model,
-- all-MiniLM-L6-v2, which outputs 384-dim vectors. The column has to match
-- whatever model actually produces the vectors being inserted.
ALTER TABLE chunks ALTER COLUMN embedding TYPE VECTOR(384);

-- The HNSW index is built for a specific vector dimension; changing the
-- column type doesn't automatically rebuild it, so drop and recreate.
DROP INDEX IF EXISTS chunks_embedding_hnsw_idx;
CREATE INDEX chunks_embedding_hnsw_idx ON chunks
  USING hnsw (embedding vector_cosine_ops);
