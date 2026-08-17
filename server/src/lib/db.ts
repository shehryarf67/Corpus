import { Pool } from 'pg'
import { formatEmbeddingForPgvector } from './vector.js'

// A pool reuses a small set of Postgres connections instead of opening a new
// connection for every query. Repositories below share this one pool.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Row types mirror PostgreSQL exactly, so database fields stay snake_case.
// They describe data returned by pg; they do not perform auth or hashing.
export type UserRow = {
  id: string
  email: string
  password_hash: string
  created_at: string
}

export type SessionRow = {
  id: string
  user_id: string
  token_hash: string
  expires_at: string
  created_at: string
}

// Future auth middleware usually needs both records at once. Keeping them
// nested makes session.id and user.id unambiguous for callers.
export type AuthenticatedSessionRow = {
  session: SessionRow
  user: UserRow
}

// SQL JOIN results are flat. This private type represents the aliased columns
// before we reshape them into AuthenticatedSessionRow below.
type AuthenticatedSessionJoinRow = {
  session_id: string
  session_user_id: string
  session_token_hash: string
  session_expires_at: string
  session_created_at: string
  user_id: string
  user_email: string
  user_password_hash: string
  user_created_at: string
}

// Repositories group database operations for one table under one clear name.
export const Users = {
  async create(email: string, passwordHash: string) {
    // Hashing happens before this helper. RETURNING gives us the inserted row
    // without needing a second SELECT.
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING *`,
      [email, passwordHash]
    )
    return rows[0]
  },

  async getById(id: string) {
    // `?? null` gives callers one predictable not-found value instead of
    // leaking the undefined value produced by rows[0].
    const { rows } = await pool.query<UserRow>(
      'SELECT * FROM users WHERE id = $1',
      [id]
    )
    return rows[0] ?? null
  },

  async getByEmail(email: string) {
    // The database compares both sides in lowercase, matching the table's
    // case-insensitive unique email index. We preserve the stored value.
    const { rows } = await pool.query<UserRow>(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    )
    return rows[0] ?? null
  },
}

export const Sessions = {
  async create(userId: string, tokenHash: string, expiresAt: Date) {
    // Only the token hash is persisted. Raw session tokens stay outside db.ts.
    const { rows } = await pool.query<SessionRow>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, tokenHash, expiresAt]
    )
    return rows[0]
  },

  async getByTokenHash(tokenHash: string) {
    // Expired rows may remain until cleanup, but they must never authenticate.
    const { rows } = await pool.query<SessionRow>(
      `SELECT *
       FROM sessions
       WHERE token_hash = $1
         AND expires_at > NOW()`,
      [tokenHash]
    )
    return rows[0] ?? null
  },

  async getWithUserByTokenHash(
    tokenHash: string
  ): Promise<AuthenticatedSessionRow | null> {
    // Middleware needs the active session and its user together. One JOIN
    // avoids a second database round trip, and aliases prevent duplicate
    // id/created_at fields from overwriting or obscuring each other.
    const { rows } = await pool.query<AuthenticatedSessionJoinRow>(
      `SELECT
         sessions.id AS session_id,
         sessions.user_id AS session_user_id,
         sessions.token_hash AS session_token_hash,
         sessions.expires_at AS session_expires_at,
         sessions.created_at AS session_created_at,
         users.id AS user_id,
         users.email AS user_email,
         users.password_hash AS user_password_hash,
         users.created_at AS user_created_at
       FROM sessions
       INNER JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = $1
         AND sessions.expires_at > NOW()`,
      [tokenHash]
    )
    const row = rows[0]
    if (!row) return null

    // Convert the flat, explicitly aliased JOIN row into a structure that is
    // straightforward for future authentication middleware to consume.
    return {
      session: {
        id: row.session_id,
        user_id: row.session_user_id,
        token_hash: row.session_token_hash,
        expires_at: row.session_expires_at,
        created_at: row.session_created_at,
      },
      user: {
        id: row.user_id,
        email: row.user_email,
        password_hash: row.user_password_hash,
        created_at: row.user_created_at,
      },
    }
  },

  async deleteByTokenHash(tokenHash: string): Promise<number> {
    // DELETE is safe when no row matches; rowCount is simply zero.
    const result = await pool.query(
      'DELETE FROM sessions WHERE token_hash = $1',
      [tokenHash]
    )
    return result.rowCount ?? 0
  },

  async deleteExpired(): Promise<number> {
    // NOW() uses the database clock and <= includes sessions expiring now.
    const result = await pool.query(
      'DELETE FROM sessions WHERE expires_at <= NOW()'
    )
    return result.rowCount ?? 0
  },

  async deleteAllForUser(userId: string): Promise<number> {
    // Removing every row revokes that user's sessions on all devices.
    const result = await pool.query(
      'DELETE FROM sessions WHERE user_id = $1',
      [userId]
    )
    return result.rowCount ?? 0
  },
}

// One conversation is one chat about one document. The actual chat text is
// stored separately in messages because one conversation has many messages.
export type ConversationRow = {
  id: string
  document_id: string
  created_at: string
}

// Restrict message roles to values accepted by both Postgres and Ollama.
export type MessageRole = 'user' | 'assistant'

// Assistant messages keep the source snapshot used for their final answer so
// reopened conversations can restore citation buttons without rerunning search.
export type StoredMessageSource = {
  label: string
  chunkId: string
  documentId: string
  pageNumber: number | null
  content: string
  highlightText?: string | null
  similarity: number | null
}

// Messages belong to a conversation and are stored one turn per row.
export type MessageRow = {
  id: string
  conversation_id: string
  role: MessageRole
  content: string
  sources: StoredMessageSource[]
  created_at: string
}

// Conversation helpers manage chat containers, not the individual messages.
export const Conversations = {
  async create(documentId: string) {
    // A conversation is tied to one document so its history cannot silently
    // mix context from unrelated PDFs.
    const { rows } = await pool.query<ConversationRow>(
      'INSERT INTO conversations (document_id) VALUES ($1) RETURNING *',
      [documentId]
    )
    return rows[0]
  },

  async getById(id: string) {
    // Used when a client sends conversationId to continue an existing chat.
    const { rows } = await pool.query<ConversationRow>(
      'SELECT * FROM conversations WHERE id = $1',
      [id]
    )
    return rows[0] ?? null
  },

  async getByIdForUser(id: string, userId: string) {
    // The JOIN makes a foreign conversation indistinguishable from a missing
    // one: both return no row to the user-facing query service.
    const { rows } = await pool.query<ConversationRow>(
      `SELECT conversations.*
       FROM conversations
       INNER JOIN documents ON documents.id = conversations.document_id
       WHERE conversations.id = $1
         AND documents.user_id = $2`,
      [id, userId]
    )
    return rows[0] ?? null
  },

  async getByDocumentId(documentId: string) {
    // Newest first is useful for a future conversation-history screen.
    const { rows } = await pool.query<ConversationRow>(
      'SELECT * FROM conversations WHERE document_id = $1 ORDER BY created_at DESC',
      [documentId]
    )
    return rows
  },

  async getLatestForDocumentForUser(documentId: string, userId: string) {
    // One joined query both enforces document ownership and selects the newest
    // conversation. A foreign document looks the same as one with no chat.
    const { rows } = await pool.query<ConversationRow>(
      `SELECT conversations.*
       FROM conversations
       INNER JOIN documents ON documents.id = conversations.document_id
       WHERE conversations.document_id = $1
         AND documents.user_id = $2
       ORDER BY conversations.created_at DESC, conversations.id DESC
       LIMIT 1`,
      [documentId, userId]
    )
    return rows[0] ?? null
  },
}

// Message helpers persist and retrieve the ordered turns inside a conversation.
export const Messages = {
  async create(
    conversationId: string,
    role: MessageRole,
    content: string,
    sources: StoredMessageSource[] = []
  ) {
    // Reject blank messages here as well as in Postgres, giving callers a
    // clearer error before a database round trip.
    const trimmedContent = content.trim()
    if (!trimmedContent) {
      throw new Error('Message content cannot be empty')
    }

    const { rows } = await pool.query<MessageRow>(
      `INSERT INTO messages (conversation_id, role, content, sources)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING *`,
      [conversationId, role, trimmedContent, JSON.stringify(sources)]
    )
    return rows[0]
  },

  async getByConversationId(conversationId: string) {
    // created_at plus id gives stable chronological ordering if two messages
    // happen to receive the same timestamp.
    const { rows } = await pool.query<MessageRow>(
      `SELECT *
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC, id ASC`,
      [conversationId]
    )
    return rows
  },

  async getRecentByConversationId(conversationId: string, limit = 10) {
    const resultLimit = Math.min(Math.max(Math.trunc(limit), 1), 50)

    // The inner query selects the newest messages. The outer query flips that
    // small result back into natural oldest-to-newest conversation order.
    const { rows } = await pool.query<MessageRow>(
      `SELECT *
       FROM (
         SELECT *
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       ) AS recent_messages
       ORDER BY created_at ASC, id ASC`,
      [conversationId, resultLimit]
    )
    return rows
  },
}

// Matches the real `documents` table columns exactly (snake_case, same as
// Postgres), not the app's camelCase convention — this describes what a row
// actually looks like coming back from a query, same role Job plays for
// the jobs table.
export type DocumentRow = {
  id: string
  user_id: string
  title: string
  filename: string
  mime_type: string
  metadata: Record<string, unknown>
  storage_key: string | null
  uploaded_at: string
}

// This projection adds the values the document UI needs. The names stay
// snake_case because this is still a PostgreSQL result, not an HTTP response.
export type DocumentListRow = DocumentRow & {
  latest_job_id: string | null
  latest_job_status: JobStatus | null
  latest_job_error: string | null
  latest_job_created_at: string | null
  latest_job_is_long_running: boolean
  chunk_count: number
  page_count: number
}

// Matches the real `chunks` table columns. Named ChunkRow, not Chunk —
// `Chunk` already means something different (the in-memory, camelCase
// shape produced by chunk.ts's groupIntoChunks), and this is a distinct
// representation: it has fields (id, document_id, created_at) the
// pipeline's Chunk never carries, since those only exist once a row is
// actually in the database.
export type ChunkRow = {
  id: string
  document_id: string
  chunk_index: number
  content: string
  page_number: number | null
  char_start: number
  char_end: number
  // pgvector's VECTOR column comes back from `pg` as its raw text
  // representation (e.g. "[0.1,0.2,...]"), not a parsed number[] — `pg`
  // has no built-in understanding of the vector type.
  embedding: string | null
  created_at: string
}

export type JobStatus = 'pending' | 'parsing' | 'embedding' | 'done' | 'failed'

// A job records the ingestion worker's current state and any failure details.
export type Job = {
  id: string
  document_id: string
  status: JobStatus
  type: string
  payload: Record<string, unknown>
  error: string | null
  created_at: string
  updated_at: string
}

export type RetryFailedJobResult =
  | { outcome: 'created'; job: Job }
  | { outcome: 'not_found' }
  | { outcome: 'missing_pdf' }
  | { outcome: 'not_failed' }

// Jobs let uploads return quickly while PDF ingestion runs in the background.
export const Jobs = {
  async create(documentId: string, type = 'ingest') {
    // New jobs use the table's default pending status.
    const { rows } = await pool.query<Job>(
      'INSERT INTO jobs (document_id, type) VALUES ($1, $2) RETURNING *',
      [documentId, type]
    )
    return rows[0]
  },

  async getById(id: string) {
    // The job-status endpoint polls this helper while ingestion is running.
    const { rows } = await pool.query<Job>('SELECT * FROM jobs WHERE id = $1', [id])
    return rows[0] ?? null
  },

  async getByIdForUser(id: string, userId: string) {
    // Jobs inherit ownership from their document. Selecting jobs.* avoids
    // returning the joined document columns or creating duplicate IDs.
    const { rows } = await pool.query<Job>(
      `SELECT jobs.*
       FROM jobs
       INNER JOIN documents ON documents.id = jobs.document_id
       WHERE jobs.id = $1
         AND documents.user_id = $2`,
      [id, userId]
    )
    return rows[0] ?? null
  },

  async getLatestForDocument(documentId: string) {
    // A document may have multiple attempts, so LIMIT 1 selects the newest.
    const { rows } = await pool.query<Job>(
      'SELECT * FROM jobs WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1',
      [documentId]
    )
    return rows[0] ?? null
  },

  async claimNextPending() {
    // Selecting and updating happen in one statement. FOR UPDATE prevents
    // another worker from taking this row, while SKIP LOCKED lets that
    // worker move on and look for a different pending job.
    const { rows } = await pool.query<Job>(
      `WITH next_job AS (
         SELECT id
         FROM jobs
         WHERE status = 'pending' AND type = 'ingest'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs AS job
       SET status = 'parsing', error = NULL
       FROM next_job
       WHERE job.id = next_job.id
       RETURNING job.*`
    )
    return rows[0] ?? null
  },

  async updateStatus(id: string, status: JobStatus, error: string | null = null) {
    // RETURNING lets the worker receive the updated state in the same query.
    const { rows } = await pool.query<Job>(
      'UPDATE jobs SET status = $2, error = $3 WHERE id = $1 RETURNING *',
      [id, status, error]
    )
    return rows[0]
  },

  async retryFailedForUser(
    documentId: string,
    userId: string
  ): Promise<RetryFailedJobResult> {
    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      // Lock the owned document for the whole retry transaction. Two quick
      // retry requests then run one after the other instead of creating two
      // pending jobs for the same PDF.
      const { rows: documents } = await client.query<{
        id: string
        storage_key: string | null
      }>(
        `SELECT id, storage_key
         FROM documents
         WHERE id = $1
           AND user_id = $2
         FOR UPDATE`,
        [documentId, userId]
      )

      if (!documents[0]) {
        await client.query('ROLLBACK')
        return { outcome: 'not_found' }
      }

      // The route checks the physical file, while this locked database check
      // prevents creating a retry if the key was cleared concurrently.
      if (!documents[0].storage_key) {
        await client.query('ROLLBACK')
        return { outcome: 'missing_pdf' }
      }

      const { rows: latestJobs } = await client.query<Job>(
        `SELECT *
         FROM jobs
         WHERE document_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [documentId]
      )

      if (latestJobs[0]?.status !== 'failed') {
        await client.query('ROLLBACK')
        return { outcome: 'not_failed' }
      }

      // A failure could theoretically happen after chunks were inserted but
      // before the job was marked done. Clear those rows so the retry cannot
      // collide with UNIQUE (document_id, chunk_index) or use partial data.
      await client.query('DELETE FROM chunks WHERE document_id = $1', [documentId])

      const { rows } = await client.query<Job>(
        `INSERT INTO jobs (document_id, type)
         VALUES ($1, 'ingest')
         RETURNING *`,
        [documentId]
      )

      const job = rows[0]
      if (!job) throw new Error('Database did not return the retry job')

      await client.query('COMMIT')
      return { outcome: 'created', job }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
}

// Document helpers manage the top-level PDF record. File bytes live in local
// storage; storage_key links that file to its database metadata.
export const Documents = {
  async create(
    userId: string,
    title: string,
    filename: string,
    mimeType: string,
    metadata: Record<string, unknown> = {},
    storageKey: string | null = null
  ) {
    // Metadata remains JSON so ingestion can attach optional details without
    // requiring a new column for each one.
    const { rows } = await pool.query<DocumentRow>(
      `INSERT INTO documents (user_id, title, filename, mime_type, metadata, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, title, filename, mimeType, metadata, storageKey]
    )
    return rows[0]
  },

  async getById(id: string) {
    // Query and ingestion services use this to verify a document exists.
    const { rows } = await pool.query<DocumentRow>('SELECT * FROM documents WHERE id = $1', [id])
    return rows[0] ?? null
  },

  async getByIdForUser(id: string, userId: string) {
    const { rows } = await pool.query<DocumentRow>(
      `SELECT *
       FROM documents
       WHERE id = $1
         AND user_id = $2`,
      [id, userId]
    )
    return rows[0] ?? null
  },

  async getAllForUser(userId: string) {
    const { rows } = await pool.query<DocumentRow>(
      `SELECT *
       FROM documents
       WHERE user_id = $1
       ORDER BY uploaded_at DESC`,
      [userId]
    )
    return rows
  },

  async listForUser(userId: string) {
    const { rows } = await pool.query<DocumentListRow>(
      `SELECT
         documents.*,
         latest_job.id AS latest_job_id,
         latest_job.status AS latest_job_status,
         latest_job.error AS latest_job_error,
         latest_job.created_at AS latest_job_created_at,
         CASE
           WHEN latest_job.status IN ('pending', 'parsing', 'embedding')
             AND latest_job.created_at <= NOW() - INTERVAL '10 minutes'
           THEN TRUE
           ELSE FALSE
         END AS latest_job_is_long_running,
         COALESCE(chunk_stats.chunk_count, 0) AS chunk_count,
         COALESCE(chunk_stats.page_count, 0) AS page_count
       FROM documents
       LEFT JOIN LATERAL (
         SELECT jobs.id, jobs.status, jobs.error, jobs.created_at
         FROM jobs
         WHERE jobs.document_id = documents.id
         ORDER BY jobs.created_at DESC, jobs.id DESC
         LIMIT 1
       ) AS latest_job ON TRUE
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*)::INTEGER AS chunk_count,
           COALESCE(MAX(chunks.page_number), 0)::INTEGER AS page_count
         FROM chunks
         WHERE chunks.document_id = documents.id
       ) AS chunk_stats ON TRUE
       WHERE documents.user_id = $1
       ORDER BY documents.uploaded_at DESC`,
      [userId]
    )
    return rows
  },

  async getDetailForUser(id: string, userId: string) {
    const { rows } = await pool.query<DocumentListRow>(
      `SELECT
         documents.*,
         latest_job.id AS latest_job_id,
         latest_job.status AS latest_job_status,
         latest_job.error AS latest_job_error,
         latest_job.created_at AS latest_job_created_at,
         CASE
           WHEN latest_job.status IN ('pending', 'parsing', 'embedding')
             AND latest_job.created_at <= NOW() - INTERVAL '10 minutes'
           THEN TRUE
           ELSE FALSE
         END AS latest_job_is_long_running,
         COALESCE(chunk_stats.chunk_count, 0) AS chunk_count,
         COALESCE(chunk_stats.page_count, 0) AS page_count
       FROM documents
       LEFT JOIN LATERAL (
         SELECT jobs.id, jobs.status, jobs.error, jobs.created_at
         FROM jobs
         WHERE jobs.document_id = documents.id
         ORDER BY jobs.created_at DESC, jobs.id DESC
         LIMIT 1
       ) AS latest_job ON TRUE
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*)::INTEGER AS chunk_count,
           COALESCE(MAX(chunks.page_number), 0)::INTEGER AS page_count
         FROM chunks
         WHERE chunks.document_id = documents.id
       ) AS chunk_stats ON TRUE
       WHERE documents.id = $1
         AND documents.user_id = $2`,
      [id, userId]
    )
    return rows[0] ?? null
  },

  async deleteByIdForUser(id: string, userId: string) {
    // Ownership and deletion happen atomically. A missing or foreign document
    // returns no row, avoiding both information leaks and check/delete races.
    const { rows } = await pool.query<DocumentRow>(
      `DELETE FROM documents
       WHERE id = $1
         AND user_id = $2
       RETURNING *`,
      [id, userId]
    )
    return rows[0] ?? null
  },

  async getAll() {
    // Internal-only unscoped listing. HTTP routes must use getAllForUser().
    const { rows } = await pool.query<DocumentRow>('SELECT * FROM documents ORDER BY uploaded_at DESC')
    return rows
  }
}

// What insertMany needs per chunk. Deliberately not the pipeline's
// EmbeddedChunk type — db.ts stays decoupled from the pdf/ folder, the
// same way chunk.ts stays decoupled from layoutText. Whoever calls this
// (the not-yet-written persistence orchestrator) is responsible for
// mapping an EmbeddedChunk into this shape, including formatting the
// embedding as pgvector's bracketed text string.
export type NewChunk = {
  chunkIndex: number
  content: string
  pageNumber: number | null
  charStart: number
  charEnd: number
  embedding: string | null
}

// A RetrievedChunk is not a new table or a separately stored object. It is
// the useful part of a chunks row returned after Postgres compares that
// chunk's embedding with the question embedding. `similarity` is calculated
// by the SELECT query for this request and is not stored in the chunks table.
export type RetrievedChunk = {
  id: string
  document_id: string
  chunk_index: number
  content: string
  page_number: number | null
  char_start: number
  char_end: number
  similarity: number
}

// Keyword retrieval returns the same useful chunk fields as vector search,
// but its score comes from Postgres full-text search rather than cosine
// similarity. Keep the score name honest because these scales are not
// directly comparable; RRF will combine their ranking positions later.
export type KeywordRetrievedChunk = {
  id: string
  document_id: string
  chunk_index: number
  content: string
  page_number: number | null
  char_start: number
  char_end: number
  keyword_score: number
}

const CHUNK_COLUMNS_PER_ROW = 7

// Chunk helpers cover ingestion persistence plus the two retrieval strategies.
export const Chunks = {
  async insertMany(documentId: string, chunks: NewChunk[]): Promise<ChunkRow[]> {
    // Avoid opening a transaction or issuing invalid SQL for an empty batch.
    if (chunks.length === 0) return []

    // A transaction needs every statement to run on the SAME connection —
    // pool.query() doesn't guarantee that (the pool can hand different
    // calls to different connections), so a transaction needs its own
    // checked-out client instead.
    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      // Building one INSERT with multiple VALUES groups: ($1,...,$7),
      // ($8,...,$14), etc. — one query, all rows, instead of one query
      // per chunk. `values` is the flat parameter list matching those
      // placeholders in order.
      const placeholders: string[] = []
      const values: unknown[] = []

      chunks.forEach((chunk, i) => {
        const offset = i * CHUNK_COLUMNS_PER_ROW
        const placeholdersForRow = Array.from(
          { length: CHUNK_COLUMNS_PER_ROW },
          (_, j) => `$${offset + j + 1}`
        )
        placeholders.push(`(${placeholdersForRow.join(', ')})`)

        values.push(
          documentId,
          chunk.chunkIndex,
          chunk.content,
          chunk.pageNumber,
          chunk.charStart,
          chunk.charEnd,
          chunk.embedding
        )
      })

      const { rows } = await client.query<ChunkRow>(
        `INSERT INTO chunks (document_id, chunk_index, content, page_number, char_start, char_end, embedding)
         VALUES ${placeholders.join(', ')}
         RETURNING *`,
        values
      )

      await client.query('COMMIT')
      return rows
    } catch (err) {
      // Any chunk failing rolls back the whole batch — no half-inserted
      // document left behind.
      await client.query('ROLLBACK')
      throw err
    } finally {
      // Always release the client back to the pool, whether the
      // transaction succeeded or failed — otherwise this connection is
      // never returned and the pool slowly runs out of connections.
      client.release()
    }
  },

  async getByDocumentId(documentId: string) {
    // Chunk index restores the document order assigned during chunking.
    const { rows } = await pool.query<ChunkRow>('SELECT * FROM chunks WHERE document_id = $1 ORDER BY chunk_index ASC', [documentId])
    return rows
  },

  async getById(id: string) {
    // IDs identify one persisted chunk independently of its position.
    const { rows } = await pool.query<ChunkRow>('SELECT * FROM chunks WHERE id = $1', [id])
    return rows[0] ?? null
  }, 

  async getByDocumentIdAndIndex(documentId: string, chunkIndex: number) {
    // The pair is unique and is useful when tests or citations know a chunk's
    // position within a particular document.
    const { rows } = await pool.query<ChunkRow>('SELECT * FROM chunks WHERE document_id = $1 AND chunk_index = $2', [documentId, chunkIndex])
    return rows[0] ?? null
  },

  async searchSimilar(
    documentId: string,
    queryEmbedding: number[],
    limit = 5
  ): Promise<RetrievedChunk[]> {
    // MiniLM produces 384-dimensional embeddings. Checking here gives us a
    // clear application error instead of a less obvious pgvector SQL error.
    if (queryEmbedding.length !== 384 || !queryEmbedding.every(Number.isFinite)) {
      throw new Error('Query embedding must contain 384 finite numbers')
    }

    // Keep callers from requesting zero, a negative number, or an extremely
    // large result set. The query pipeline normally asks for five results.
    const resultLimit = Math.min(Math.max(Math.trunc(limit), 1), 50)
    const formattedEmbedding = formatEmbeddingForPgvector(queryEmbedding)

    const { rows } = await pool.query<RetrievedChunk>(
      `SELECT
         id,
         document_id,
         chunk_index,
         content,
         page_number,
         char_start,
         char_end,
         1 - (embedding <=> $2::vector) AS similarity
       FROM chunks
       WHERE document_id = $1
         AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      // $1 scopes the search to one document. $2 is the question vector in
      // pgvector text form. $3 controls how many top matches come back.
      [documentId, formattedEmbedding, resultLimit]
    )

    // Postgres has already compared and ranked the vectors. JavaScript only
    // receives the best matching rows; it never downloads every embedding.
    return rows
  },

  async searchByKeyword(
    documentId: string,
    question: string,
    limit = 20
  ): Promise<KeywordRetrievedChunk[]> {
    // An empty text query has no useful keywords and should produce no
    // candidates instead of making an unnecessary database request.
    const trimmedQuestion = question.trim()
    if (!trimmedQuestion) return []

    const resultLimit = Math.min(Math.max(Math.trunc(limit), 1), 50)

    const { rows } = await pool.query<KeywordRetrievedChunk>(
      `WITH terms AS (
         SELECT tsvector_to_array(to_tsvector('english', $2)) AS values
       ),
       query AS (
         SELECT CASE
           WHEN cardinality(terms.values) = 0 THEN NULL
           ELSE to_tsquery('english', array_to_string(terms.values, ' | '))
         END AS value
         FROM terms
       )
       SELECT
         chunks.id,
         chunks.document_id,
         chunks.chunk_index,
         chunks.content,
         chunks.page_number,
         chunks.char_start,
         chunks.char_end,
         ts_rank_cd(chunks.search_vector, query.value) AS keyword_score
       FROM chunks
       CROSS JOIN query
       WHERE chunks.document_id = $1
         AND query.value IS NOT NULL
         AND chunks.search_vector @@ query.value
       ORDER BY keyword_score DESC, chunks.chunk_index ASC
       LIMIT $3`,
      // Postgres first normalizes/stems the raw question into safe lexemes,
      // then joins those terms with OR. Requiring every natural-question term
      // caused valid chunks to disappear when one word was absent. Values
      // remain query parameters, so user text never becomes SQL syntax.
      [documentId, trimmedQuestion, resultLimit]
    )

    // Unlike vector search, full-text search returns only chunks that contain
    // matching normalized terms. No match legitimately means an empty array.
    return rows
  },
}
