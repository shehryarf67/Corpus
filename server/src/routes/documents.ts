import { Hono } from 'hono'
import {
  Documents,
  Jobs,
  type DocumentListRow,
  type JobStatus,
} from '../lib/db.js'
import { deletePdf, savePdf } from '../lib/storage.js'
import { requireAuth, type AuthEnv } from '../middleware/auth.js'

export const documentsRoute = new Hono<AuthEnv>()

// Pathless use applies authentication to every route declared below without
// relying on Hono's explicit wildcard path matching.
documentsRoute.use(requireAuth)

// This is the public contract shared by both document GET endpoints. Database
// rows remain snake_case; JSON sent to the frontend uses camelCase.
export type DocumentResponse = {
  id: string
  title: string
  filename: string
  mimeType: string
  uploadedAt: string
  status: JobStatus | null
  error: string | null
  chunkCount: number
  pageCount: number
}

export type DocumentsResponse = {
  documents: DocumentResponse[]
}

export type SingleDocumentResponse = {
  document: DocumentResponse
}

function publicDocument(document: DocumentListRow): DocumentResponse {
  return {
    id: document.id,
    title: document.title,
    filename: document.filename,
    mimeType: document.mime_type,
    uploadedAt: document.uploaded_at,
    status: document.latest_job_status,
    error: document.latest_job_error,
    chunkCount: document.chunk_count,
    pageCount: document.page_count,
  }
}

documentsRoute.get('/', async (c) => {
  const documents = await Documents.listForUser(c.get('user').id)
  const response: DocumentsResponse = {
    documents: documents.map(publicDocument),
  }
  return c.json(response)
})

documentsRoute.get('/:documentId', async (c) => {
  const document = await Documents.getDetailForUser(
    c.req.param('documentId'),
    c.get('user').id
  )

  // Missing and foreign documents intentionally produce the same response.
  if (!document) return c.json({ error: 'Document not found' }, 404)
  const response: SingleDocumentResponse = {
    document: publicDocument(document),
  }
  return c.json(response)
})

documentsRoute.delete('/:documentId', async (c) => {
  const userId = c.get('user').id
  const document = await Documents.deleteByIdForUser(
    c.req.param('documentId'),
    userId
  )

  if (!document) return c.json({ error: 'Document not found' }, 404)

  // The database deletion already succeeded and cascaded to related rows.
  // File cleanup is best-effort because the filesystem cannot join that SQL
  // transaction; a failure leaves an orphaned file, not accessible user data.
  if (document.storage_key) {
    await deletePdf(document.storage_key).catch((error) => {
      console.error(`could not delete stored PDF ${document.storage_key}`, error)
    })
  }

  return c.json({ ok: true })
})

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
      c.get('user').id,
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
      await Documents.deleteByIdForUser(documentId, c.get('user').id).catch(
        () => undefined
      )
    }
    if (storageKey) {
      await deletePdf(storageKey).catch(() => undefined)
    }

    const message = error instanceof Error ? error.message : 'Upload failed'
    return c.json({ error: message }, 500)
  }
})
