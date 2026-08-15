import { Hono } from 'hono'
import {
  Conversations,
  Documents,
  Jobs,
  Messages,
  type DocumentListRow,
  type JobStatus,
  type MessageRole,
  type StoredMessageSource,
} from '../lib/db.js'
import { deletePdf, readPdf, savePdf } from '../lib/storage.js'
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
  jobId: string | null
  jobCreatedAt: string | null
  processingLongerThanExpected: boolean
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

export type ConversationMessageResponse = {
  id: string
  role: MessageRole
  content: string
  sources: StoredMessageSource[]
  createdAt: string
}

export type DocumentConversationResponse = {
  conversation: {
    id: string
    documentId: string
    createdAt: string
  } | null
  messages: ConversationMessageResponse[]
}

function publicDocument(document: DocumentListRow): DocumentResponse {
  return {
    id: document.id,
    title: document.title,
    filename: document.filename,
    mimeType: document.mime_type,
    uploadedAt: document.uploaded_at,
    jobId: document.latest_job_id,
    jobCreatedAt: document.latest_job_created_at,
    processingLongerThanExpected: document.latest_job_is_long_running,
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

documentsRoute.get('/:documentId/conversation', async (c) => {
  const documentId = c.req.param('documentId')
  const userId = c.get('user').id

  // Check the document separately so an owned document with no conversation
  // returns an empty successful state, while missing/foreign documents are 404.
  const document = await Documents.getByIdForUser(documentId, userId)
  if (!document) return c.json({ error: 'Document not found' }, 404)

  const conversation = await Conversations.getLatestForDocumentForUser(
    documentId,
    userId
  )

  if (!conversation) {
    const response: DocumentConversationResponse = {
      conversation: null,
      messages: [],
    }
    return c.json(response)
  }

  const messages = await Messages.getByConversationId(conversation.id)
  const response: DocumentConversationResponse = {
    conversation: {
      id: conversation.id,
      documentId: conversation.document_id,
      createdAt: conversation.created_at,
    },
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      sources: message.sources,
      createdAt: message.created_at,
    })),
  }
  return c.json(response)
})

documentsRoute.get('/:documentId/pdf', async (c) => {
  const document = await Documents.getByIdForUser(
    c.req.param('documentId'),
    c.get('user').id
  )

  if (!document || !document.storage_key) {
    return c.json({ error: "Document not found" }, 404)
  }

  try {
    const pdfBuffer = await readPdf(document.storage_key)
    const pdfBytes = new Uint8Array(pdfBuffer)

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="safe-name.pdf"',
      },
    })
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return c.json({ error: "Document not found" }, 404) // We need to throw specifically error 404 here because the file is missing, 
      // but the document row exists. This is a rare case, but it can happen if the file was deleted from storage after the document was created.
    }

    throw error
  }
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

documentsRoute.post('/:documentId/retry', async (c) => {
  try {
    const result = await Jobs.retryFailedForUser(
      c.req.param('documentId'),
      c.get('user').id
    )

    // Missing and foreign documents intentionally produce the same response.
    if (result.outcome === 'not_found') {
      return c.json({ error: 'Document not found' }, 404)
    }

    if (result.outcome === 'not_failed') {
      return c.json({ error: 'Only failed documents can be retried' }, 409)
    }

    return c.json(
      {
        documentId: result.job.document_id,
        jobId: result.job.id,
        status: result.job.status,
      },
      202
    )
  } catch (error) {
    console.error(
      `could not retry document ${c.req.param('documentId')}`,
      error
    )
    return c.json({ error: 'Could not retry document indexing' }, 500)
  }
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
