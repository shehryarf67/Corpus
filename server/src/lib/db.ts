import { Pool } from 'pg'

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const User = {

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