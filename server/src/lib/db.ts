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
