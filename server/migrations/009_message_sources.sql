ALTER TABLE messages
  ADD COLUMN sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT messages_sources_is_array
    CHECK (jsonb_typeof(sources) = 'array');
