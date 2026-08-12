import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Hono } from 'hono'
import { Chunks, Documents, Jobs, pool } from '../src/lib/db.js'
import { documentsRoute } from '../src/routes/documents.js'
import {
  createTestSessionCookie,
  createTestUser,
} from './auth-fixture.js'

after(async () => {
  await pool.end()
})

test('an owner can retry only the latest failed ingestion job', async () => {
  const owner = await createTestUser('retry-owner')
  const stranger = await createTestUser('retry-stranger')
  const ownerCookie = await createTestSessionCookie(owner.id)
  const strangerCookie = await createTestSessionCookie(stranger.id)
  const document = await Documents.create(
    owner.id,
    'Retry document',
    'retry.pdf',
    'application/pdf'
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
