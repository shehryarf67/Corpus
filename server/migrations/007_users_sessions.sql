-- ============================================================
-- 007_users_sessions.sql
--
-- Adds the authentication foundation for Corpus.
--
-- users:
--   Stores the account itself and the password hash.
--
-- sessions:
--   Stores active login sessions. We NEVER store the raw
--   session token in Postgres. The server will SHA-256 the
--   browser token and store only token_hash here.
-- ============================================================


-- ------------------------------------------------------------
-- USERS
-- ------------------------------------------------------------

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Keep email as normal TEXT rather than using citext.
    -- Case-insensitive uniqueness is enforced by the index below.
    email TEXT NOT NULL,

    -- This will contain our self-describing scrypt hash record,
    -- NOT the user's actual password.
    password_hash TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- Emails should be unique regardless of capitalisation.
--
-- Without this:
--   Faisal@example.com
--   faisal@example.com
--
-- could technically become two separate accounts.
--
-- We deliberately use an expression index instead of citext.
CREATE UNIQUE INDEX users_email_lower_unique
    ON users (LOWER(email));


-- ------------------------------------------------------------
-- SESSIONS
-- ------------------------------------------------------------

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    -- The browser receives a cryptographically random session
    -- token, but Postgres stores only SHA-256(token).
    --
    -- If the database is leaked, an attacker therefore does not
    -- immediately receive usable live session cookies.
    token_hash TEXT NOT NULL,

    expires_at TIMESTAMPTZ NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- There should never be two session rows for the exact same
-- token hash.
CREATE UNIQUE INDEX sessions_token_hash_unique
    ON sessions (token_hash);


-- Useful when listing/revoking all sessions belonging to a user,
-- and for ON DELETE CASCADE operations.
CREATE INDEX sessions_user_id_idx
    ON sessions (user_id);


-- Useful later if we want a cleanup/reaper query such as:
--
-- DELETE FROM sessions WHERE expires_at < NOW();
CREATE INDEX sessions_expires_at_idx
    ON sessions (expires_at);