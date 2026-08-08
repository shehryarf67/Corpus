-- ============================================================
-- 008_document_ownership.sql
--
-- Makes every document belong to exactly one user.
--
-- Existing documents were created before authentication existed,
-- so we first create one disabled migration-only user and assign
-- all existing documents to it.
--
-- Only after the backfill is complete do we make user_id
-- NOT NULL.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Add ownership column as nullable FIRST
-- ------------------------------------------------------------
--
-- We cannot immediately make this NOT NULL because documents may
-- already exist in the database and those old rows obviously do
-- not yet have an owner.

ALTER TABLE documents
ADD COLUMN user_id UUID
    REFERENCES users(id)
    ON DELETE CASCADE;


-- ------------------------------------------------------------
-- 2. Create a migration-only owner for legacy documents
-- ------------------------------------------------------------
--
-- Existing documents need somewhere to go before user_id can
-- become NOT NULL.
--
-- This is not intended to be a usable login account.
--
-- The .invalid TLD is reserved and cannot accidentally correspond
-- to a real email destination.
--
-- The password_hash deliberately does not contain a valid scrypt
-- record, so our authentication layer should never authenticate
-- this account.

INSERT INTO users (
    email,
    password_hash
)
VALUES (
    'legacy-migration@corpus.invalid',
    'disabled:legacy-migration'
);


-- ------------------------------------------------------------
-- 3. Give all pre-authentication documents to that user
-- ------------------------------------------------------------

UPDATE documents
SET user_id = (
    SELECT id
    FROM users
    WHERE LOWER(email) = LOWER('legacy-migration@corpus.invalid')
)
WHERE user_id IS NULL;


-- ------------------------------------------------------------
-- 4. Ownership is now mandatory
-- ------------------------------------------------------------
--
-- From this point onwards it becomes impossible to insert a
-- document without an owner.

ALTER TABLE documents
ALTER COLUMN user_id SET NOT NULL;


-- ------------------------------------------------------------
-- 5. Index ownership
-- ------------------------------------------------------------
--
-- Most frontend document queries will eventually look roughly
-- like:
--
-- SELECT ...
-- FROM documents
-- WHERE user_id = $1
-- ORDER BY uploaded_at DESC;
--
-- This composite index supports that access pattern.

CREATE INDEX documents_user_uploaded_at_idx
    ON documents (user_id, uploaded_at DESC);