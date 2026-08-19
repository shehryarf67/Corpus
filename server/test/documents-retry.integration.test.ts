import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { Hono } from 'hono'
import {
  Chunks,
  Conversations,
  Documents,
  Jobs,
  Messages,
  pool,
} from '../src/lib/db.js'
import { documentsRoute } from '../src/routes/documents.js'
import { deletePdf, pdfExists, savePdf } from '../src/lib/storage.js'
import {
  createTestSessionCookie,
  createTestUser,
} from './auth-fixture.js'

let testStorageDirectory: string
let previousStorageDirectory: string | undefined

before(async () => {
  previousStorageDirectory = process.env.PDF_STORAGE_DIR
  testStorageDirectory = await mkdtemp(path.join(tmpdir(), 'corpus-retry-'))
  process.env.PDF_STORAGE_DIR = testStorageDirectory
})

after(async () => {
  if (previousStorageDirectory === undefined) {
    delete process.env.PDF_STORAGE_DIR
  } else {
    process.env.PDF_STORAGE_DIR = previousStorageDirectory
  }
  await rm(testStorageDirectory, { recursive: true, force: true })
  await pool.end()
})

test('an owner can retry only the latest failed ingestion job', async () => {
  const owner = await createTestUser('retry-owner')
  const stranger = await createTestUser('retry-stranger')
  const ownerCookie = await createTestSessionCookie(owner.id)
  const strangerCookie = await createTestSessionCookie(stranger.id)
  const storageKey = await savePdf(Buffer.from('%PDF-1.4\nRetry test'))
  const document = await Documents.create(
    owner.id,
    'Retry document',
    'retry.pdf',
    'application/pdf',
    {},
    storageKey
  )
  if (!document) throw new Error('Failed to create retry document')

  const failedJob = await Jobs.create(document.id)
  if (!failedJob) throw new Error('Failed to create retry job')

  const app = new Hono()
  app.route('/documents', documentsRoute)

  try {
    await Jobs.updateStatus(failedJob.id, 'failed', 'Test ingestion failure')

    // Simulate a late failure that left chunks behind. Retry must clear them
    // before the worker inserts replacement chunks with the same indexes.
    await Chunks.insertMany(document.id, [
      {
        chunkIndex: 0,
        content: 'Partial chunk',
        pageNumber: 1,
        charStart: 0,
        charEnd: 13,
        embedding: null,
      },
    ])

    const foreignResponse = await app.request(
      `/documents/${document.id}/retry`,
      { method: 'POST', headers: { Cookie: strangerCookie } }
    )
    assert.equal(foreignResponse.status, 404)

    const response = await app.request(`/documents/${document.id}/retry`, {
      method: 'POST',
      headers: { Cookie: ownerCookie },
    })
    assert.equal(response.status, 202)

    const body = (await response.json()) as {
      documentId: string
      jobId: string
      status: string
    }
    assert.equal(body.documentId, document.id)
    assert.equal(body.status, 'pending')
    assert.notEqual(body.jobId, failedJob.id)
    assert.deepEqual(await Chunks.getByDocumentId(document.id), [])

    const latestJob = await Jobs.getLatestForDocument(document.id)
    assert.equal(latestJob?.id, body.jobId)
    assert.equal(latestJob?.status, 'pending')

    // The new pending job is now latest, so another retry is rejected rather
    // than creating a duplicate active attempt.
    const duplicateResponse = await app.request(
      `/documents/${document.id}/retry`,
      { method: 'POST', headers: { Cookie: ownerCookie } }
    )
    assert.equal(duplicateResponse.status, 409)
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      [owner.id, stranger.id],
    ])
  }
})

test('retry refuses to create another job when the original PDF is missing', async () => {
  const owner = await createTestUser('retry-missing-pdf-owner')
  const ownerCookie = await createTestSessionCookie(owner.id)
  const document = await Documents.create(
    owner.id,
    'Missing original PDF',
    'missing.pdf',
    'application/pdf'
  )
  if (!document) throw new Error('Failed to create missing-PDF document')

  const failedJob = await Jobs.create(document.id)
  if (!failedJob) throw new Error('Failed to create missing-PDF job')
  await Jobs.updateStatus(failedJob.id, 'failed', 'Original file disappeared')

  const app = new Hono()
  app.route('/documents', documentsRoute)

  try {
    const response = await app.request(`/documents/${document.id}/retry`, {
      method: 'POST',
      headers: { Cookie: ownerCookie },
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'Original PDF no longer exists. Upload it again.',
      code: 'original_pdf_missing',
    })

    // No doomed pending job was created; the original failed attempt remains
    // the latest job for the document.
    assert.equal((await Jobs.getLatestForDocument(document.id))?.id, failedJob.id)
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [owner.id])
  }
})

test('retry refuses when storage_key remains but its physical file is gone', async () => {
  const owner = await createTestUser('retry-deleted-file-owner')
  const ownerCookie = await createTestSessionCookie(owner.id)
  const storageKey = await savePdf(Buffer.from('%PDF-1.4\nDeleted file test'))
  const document = await Documents.create(
    owner.id,
    'Deleted physical PDF',
    'deleted-file.pdf',
    'application/pdf',
    {},
    storageKey
  )
  if (!document) throw new Error('Failed to create deleted-file document')

  const failedJob = await Jobs.create(document.id)
  if (!failedJob) throw new Error('Failed to create deleted-file job')
  await Jobs.updateStatus(failedJob.id, 'failed', 'Original file disappeared')
  await deletePdf(storageKey)

  const app = new Hono()
  app.route('/documents', documentsRoute)

  try {
    const response = await app.request(`/documents/${document.id}/retry`, {
      method: 'POST',
      headers: { Cookie: ownerCookie },
    })

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      error: 'Original PDF no longer exists. Upload it again.',
      code: 'original_pdf_missing',
    })
    assert.equal((await Jobs.getLatestForDocument(document.id))?.id, failedJob.id)
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [owner.id])
  }
})

test('deleting a document removes its stored PDF and pending job', async () => {
  const owner = await createTestUser('delete-storage-owner')
  const ownerCookie = await createTestSessionCookie(owner.id)
  const storageKey = await savePdf(Buffer.from('%PDF-1.4\nDelete test'))
  const document = await Documents.create(
    owner.id,
    'Delete document and storage',
    'delete.pdf',
    'application/pdf',
    {},
    storageKey
  )
  if (!document) throw new Error('Failed to create deletion document')

  const pendingJob = await Jobs.create(document.id)
  if (!pendingJob) throw new Error('Failed to create deletion job')
  await Chunks.insertMany(document.id, [
    {
      chunkIndex: 0,
      content: 'Cascade deletion test chunk.',
      pageNumber: 1,
      charStart: 0,
      charEnd: 28,
      embedding: null,
    },
  ])
  const conversation = await Conversations.create(document.id)
  if (!conversation) throw new Error('Failed to create deletion conversation')
  const message = await Messages.create(
    conversation.id,
    'user',
    'Will this message cascade?'
  )
  if (!message) throw new Error('Failed to create deletion message')

  const app = new Hono()
  app.route('/documents', documentsRoute)

  try {
    const response = await app.request(`/documents/${document.id}`, {
      method: 'DELETE',
      headers: { Cookie: ownerCookie },
    })

    assert.equal(response.status, 200)
    assert.equal(await Documents.getById(document.id), null)
    assert.equal(await Jobs.getById(pendingJob.id), null)
    assert.deepEqual(await Chunks.getByDocumentId(document.id), [])
    assert.equal(await Conversations.getById(conversation.id), null)
    const { rows: remainingMessages } = await pool.query(
      'SELECT id FROM messages WHERE id = $1',
      [message.id]
    )
    assert.deepEqual(remainingMessages, [])
    assert.equal(await pdfExists(storageKey), false)
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [owner.id])
  }
})

test('deleting a document succeeds when its physical PDF is already missing', async () => {
  const owner = await createTestUser('delete-already-missing-owner')
  const ownerCookie = await createTestSessionCookie(owner.id)
  const storageKey = await savePdf(Buffer.from('%PDF-1.4\nAlready missing'))
  const document = await Documents.create(
    owner.id,
    'Already missing PDF',
    'already-missing.pdf',
    'application/pdf',
    {},
    storageKey
  )
  if (!document) throw new Error('Failed to create missing-file deletion fixture')

  await deletePdf(storageKey)
  const app = new Hono()
  app.route('/documents', documentsRoute)

  try {
    const response = await app.request(`/documents/${document.id}`, {
      method: 'DELETE',
      headers: { Cookie: ownerCookie },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(await Documents.getById(document.id), null)
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [owner.id])
  }
})

test('a storage-stage upload failure leaves no database document', async () => {
  const owner = await createTestUser('upload-storage-failure-owner')
  const ownerCookie = await createTestSessionCookie(owner.id)
  const app = new Hono()
  app.route('/documents', documentsRoute)

  const formData = new FormData()
  formData.append(
    'file',
    new File([Buffer.from('not a real PDF')], 'broken.pdf', {
      type: 'application/pdf',
    })
  )

  try {
    const response = await app.request('/documents', {
      method: 'POST',
      headers: { Cookie: ownerCookie },
      body: formData,
    })

    assert.equal(response.status, 500)
    assert.deepEqual(await Documents.getAllForUser(owner.id), [])
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [owner.id])
  }
})
