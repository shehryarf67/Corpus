import { Pool } from 'pg'
import { formatEmbeddingForPgvector } from './vector.js'

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const User = {

}

// One conversation is one chat about one document. The actual chat text is
// stored separately in messages because one conversation has many messages.
export type ConversationRow = {
  id: string
  document_id: string
  created_at: string
}

export type MessageRole = 'user' | 'assistant'

export type MessageRow = {
  id: string
  conversation_id: string
  role: MessageRole
  content: string
  created_at: string
}

export const Conversations = {
  async create(documentId: string) {
    const { rows } = await pool.query<ConversationRow>(
      'INSERT INTO conversations (document_id) VALUES ($1) RETURNING *',
      [documentId]
    )
    return rows[0]
  },

  async getById(id: string) {
    const { rows } = await pool.query<ConversationRow>(
      'SELECT * FROM conversations WHERE id = $1',
      [id]
    )
    return rows[0] ?? null
  },

  async getByDocumentId(documentId: string) {
    const { rows } = await pool.query<ConversationRow>(
      'SELECT * FROM conversations WHERE document_id = $1 ORDER BY created_at DESC',
      [documentId]
    )
    return rows
  },
}

export const Messages = {
  async create(conversationId: string, role: MessageRole, content: string) {
    const trimmedContent = content.trim()
    if (!trimmedContent) {
      throw new Error('Message content cannot be empty')
    }

    const { rows } = await pool.query<MessageRow>(
      `INSERT INTO messages (conversation_id, role, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [conversationId, role, trimmedContent]
    )
    return rows[0]
  },

  async getByConversationId(conversationId: string) {
    const { rows } = await pool.query<MessageRow>(
      `SELECT *
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC, id ASC`,
      [conversationId]
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
  title: string
  filename: string
  mime_type: string
  metadata: Record<string, unknown>
  storage_key: string | null
  uploaded_at: string
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

export const Jobs = {
  async create(documentId: string, type = 'ingest') {
    const { rows } = await pool.query<Job>(
      'INSERT INTO jobs (document_id, type) VALUES ($1, $2) RETURNING *',
      [documentId, type]
    )
    return rows[0]
  },

  async getById(id: string) {
    const { rows } = await pool.query<Job>('SELECT * FROM jobs WHERE id = $1', [id])
    return rows[0] ?? null
  },

  async getLatestForDocument(documentId: string) {
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
    const { rows } = await pool.query<Job>(
      'UPDATE jobs SET status = $2, error = $3 WHERE id = $1 RETURNING *',
      [id, status, error]
    )
    return rows[0]
  },
}

export const Documents = {
  async create(
    title: string,
    filename: string,
    mimeType: string,
    metadata: Record<string, unknown> = {},
    storageKey: string | null = null
  ) {
    const { rows } = await pool.query<DocumentRow>(
      `INSERT INTO documents (title, filename, mime_type, metadata, storage_key)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [title, filename, mimeType, metadata, storageKey]
    )
    return rows[0]
  },

  async getById(id: string) {
    const { rows } = await pool.query<DocumentRow>('SELECT * FROM documents WHERE id = $1', [id])
    return rows[0] ?? null
  },

  async getAll() {
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

export const Chunks = {
  async insertMany(documentId: string, chunks: NewChunk[]): Promise<ChunkRow[]> {
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
    const { rows } = await pool.query<ChunkRow>('SELECT * FROM chunks WHERE document_id = $1 ORDER BY chunk_index ASC', [documentId])
    return rows
  },

  async getById(id: string) {
    const { rows } = await pool.query<ChunkRow>('SELECT * FROM chunks WHERE id = $1', [id])
    return rows[0] ?? null
  }, 

  async getByDocumentIdAndIndex(documentId: string, chunkIndex: number) {
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
