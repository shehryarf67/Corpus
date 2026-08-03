import { Pool } from 'pg'

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const User = {

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

  async updateStatus(id: string, status: JobStatus, error: string | null = null) {
    const { rows } = await pool.query<Job>(
      'UPDATE jobs SET status = $2, error = $3 WHERE id = $1 RETURNING *',
      [id, status, error]
    )
    return rows[0]
  },
}

export const Documents = {
  async create(title: string, filename: string, mimeType: string, metadata: Record<string, unknown>) {
    const { rows } = await pool.query<DocumentRow>(
      'INSERT INTO documents (title, filename, mime_type, metadata) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, filename, mimeType, metadata]
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
  }
}
