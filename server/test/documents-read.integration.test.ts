import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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

test('document list and detail return owned aggregate data and the latest job', async () => {
  const owner = await createTestUser('documents-read-owner')
  const stranger = await createTestUser('documents-read-stranger')
  const ownerCookie = await createTestSessionCookie(owner.id)

  const ownedDocument = await Documents.create(
    owner.id,
    'Owned aggregate document',
    'owned.pdf',
    'application/pdf'
  )
  const foreignDocument = await Documents.create(
    stranger.id,
    'Foreign aggregate document',
    'foreign.pdf',
    'application/pdf'
  )
  if (!ownedDocument || !foreignDocument) {
    throw new Error('Failed to create document read test fixtures')
  }

  const olderJob = await Jobs.create(ownedDocument.id)
  const latestJob = await Jobs.create(ownedDocument.id)
  if (!olderJob || !latestJob) {
    throw new Error('Failed to create document job fixtures')
  }

  const app = new Hono()
  app.route('/documents', documentsRoute)

  try {
    await Jobs.updateStatus(olderJob.id, 'failed', 'Old failure')
    await Jobs.updateStatus(latestJob.id, 'done')

    // Fixed timestamps make the newest-job expectation deterministic even if
    // both rows were created within the same database clock tick.
    await pool.query(
      `UPDATE jobs
       SET created_at = CASE
         WHEN id = $1 THEN NOW() - INTERVAL '1 hour'
         WHEN id = $2 THEN NOW()
       END
       WHERE id = ANY($3::uuid[])`,
      [olderJob.id, latestJob.id, [olderJob.id, latestJob.id]]
    )

    await Chunks.insertMany(ownedDocument.id, [
      {
        chunkIndex: 0,
        content: 'Page one, first chunk.',
        pageNumber: 1,
        charStart: 0,
        charEnd: 22,
        embedding: null,
      },
      {
        chunkIndex: 1,
        content: 'Page one, second chunk.',
        pageNumber: 1,
        charStart: 23,
        charEnd: 46,
        embedding: null,
      },
      {
        chunkIndex: 2,
        content: 'Page three chunk.',
        pageNumber: 3,
        charStart: 0,
        charEnd: 17,
        embedding: null,
      },
    ])

    const repositoryList = await Documents.listForUser(owner.id)
    assert.equal(repositoryList.length, 1)
    assert.equal(repositoryList[0]?.id, ownedDocument.id)
    assert.equal(repositoryList[0]?.chunk_count, 3)
    assert.equal(repositoryList[0]?.page_count, 3)
    assert.equal(repositoryList[0]?.latest_job_status, 'done')
    assert.equal(repositoryList[0]?.latest_job_error, null)

    const repositoryDetail = await Documents.getDetailForUser(
      ownedDocument.id,
      owner.id
    )
    assert.equal(repositoryDetail?.chunk_count, 3)
    assert.equal(repositoryDetail?.page_count, 3)
    assert.equal(repositoryDetail?.latest_job_status, 'done')

    const listResponse = await app.request('/documents', {
      headers: { Cookie: ownerCookie },
    })
    assert.equal(listResponse.status, 200)
    const listBody = (await listResponse.json()) as {
      documents: Array<Record<string, unknown>>
    }
    assert.equal(listBody.documents.length, 1)
    assert.deepEqual(listBody.documents[0], {
      id: ownedDocument.id,
      title: ownedDocument.title,
      filename: ownedDocument.filename,
      mimeType: ownedDocument.mime_type,
      uploadedAt: ownedDocument.uploaded_at,
      status: 'done',
      error: null,
      chunkCount: 3,
      pageCount: 3,
    })

    const detailResponse = await app.request(
      `/documents/${ownedDocument.id}`,
      { headers: { Cookie: ownerCookie } }
    )
    assert.equal(detailResponse.status, 200)
    assert.deepEqual(await detailResponse.json(), {
      document: listBody.documents[0],
    })
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      [owner.id, stranger.id],
    ])
  }
})

test('document detail gives the same 404 for missing and foreign documents', async () => {
  const owner = await createTestUser('documents-404-owner')
  const stranger = await createTestUser('documents-404-stranger')
  const ownerCookie = await createTestSessionCookie(owner.id)
  const foreignDocument = await Documents.create(
    stranger.id,
    'Hidden document',
    'hidden.pdf',
    'application/pdf'
  )
  if (!foreignDocument) throw new Error('Failed to create foreign document')

  const app = new Hono()
  app.route('/documents', documentsRoute)

  try {
    const foreignResponse = await app.request(
      `/documents/${foreignDocument.id}`,
      { headers: { Cookie: ownerCookie } }
    )
    const missingResponse = await app.request(`/documents/${randomUUID()}`, {
      headers: { Cookie: ownerCookie },
    })

    assert.equal(foreignResponse.status, 404)
    assert.equal(missingResponse.status, 404)
    assert.deepEqual(await foreignResponse.json(), {
      error: 'Document not found',
    })
    assert.deepEqual(await missingResponse.json(), {
      error: 'Document not found',
    })
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      [owner.id, stranger.id],
    ])
  }
})
