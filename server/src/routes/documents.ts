import { Hono } from 'hono'
import { Documents, Jobs, pool } from '../lib/db.js'
import { deletePdf, savePdf } from '../lib/storage.js'
import { requireAuth, type AuthEnv } from '../middleware/auth.js'

export const documentsRoute = new Hono<AuthEnv>()

// Pathless use applies authentication to every route declared below without
// relying on Hono's explicit wildcard path matching.
documentsRoute.use(requireAuth)

documentsRoute.post('/', async (c) => {
  let storageKey: string | null = null
  let documentId: string | null = null

  try {
    const body = await c.req.parseBody()
    const file = body.file
    const suppliedTitle = body.title

    if (!(file instanceof File)) {
      return c.json({ error: 'A PDF file is required in the file field' }, 400)
    }

    if (suppliedTitle !== undefined && typeof suppliedTitle !== 'string') {
      return c.json({ error: 'Title must be text' }, 400)
    }

    if (file.type && file.type !== 'application/pdf') {
      return c.json({ error: 'Only PDF files are supported' }, 415)
    }

    const fileBuffer = Buffer.from(await file.arrayBuffer())
    storageKey = await savePdf(fileBuffer)

    const filenameTitle = file.name.replace(/\.pdf$/i, '').trim()
    const title = suppliedTitle?.trim() || filenameTitle || 'Untitled document'

    const document = await Documents.create(
      title,
      file.name,
      file.type || 'application/pdf',
      { size: file.size },
      storageKey
    )
    if (!document) {
      throw new Error('Database did not return the created document')
    }
    documentId = document.id

    const job = await Jobs.create(document.id)
    if (!job) {
      throw new Error('Database did not return the created ingestion job')
    }

    return c.json(
      {
        documentId: document.id,
        jobId: job.id,
        status: job.status,
      },
      202
    )
  } catch (error) {
    // The filesystem and Postgres cannot share one transaction. If setup
    // fails halfway through, remove anything this request already created.
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId]).catch(() => undefined)
    }
    if (storageKey) {
      await deletePdf(storageKey).catch(() => undefined)
    }

    const message = error instanceof Error ? error.message : 'Upload failed'
    return c.json({ error: message }, 500)
  }
})
