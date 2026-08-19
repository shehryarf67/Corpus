import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { Hono } from 'hono'
import { Documents, Jobs, pool } from '../src/lib/db.js'
import { documentsRoute } from '../src/routes/documents.js'
import { jobsRoute } from '../src/routes/jobs.js'
import { queryRoute } from '../src/routes/query.js'
import { savePdf, saveThumbnail } from '../src/lib/storage.js'
import {
  createTestSessionCookie,
  createTestUser,
} from './auth-fixture.js'

after(async () => {
  await pool.end()
})

test('foreign documents and jobs are hidden behind 404 responses', async () => {
  const owner = await createTestUser('ownership-owner')
  const stranger = await createTestUser('ownership-stranger')
  const ownerCookie = await createTestSessionCookie(owner.id)
  const strangerCookie = await createTestSessionCookie(stranger.id)
  const storageKey = await savePdf(Buffer.from('%PDF-1.4\n%%EOF'))

  const document = await Documents.create(
    owner.id,
    'Private ownership test',
    'private.pdf',
    'application/pdf',
    {},
    storageKey
  )
  if (!document) throw new Error('Failed to create ownership test document')
  const thumbnailKey = await saveThumbnail(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
  )
  await Documents.setThumbnailKeyIfMissing(document.id, thumbnailKey)
  const job = await Jobs.create(document.id)
  if (!job) throw new Error('Failed to create ownership test job')

  const app = new Hono()
  app.route('/documents', documentsRoute)
  app.route('/jobs', jobsRoute)
  app.route('/query', queryRoute)

  try {
    const foreignDocument = await app.request(`/documents/${document.id}`, {
      headers: { Cookie: strangerCookie },
    })
    const foreignJob = await app.request(`/jobs/${job.id}`, {
      headers: { Cookie: strangerCookie },
    })
    const foreignPdf = await app.request(`/documents/${document.id}/pdf`, {
      headers: { Cookie: strangerCookie },
    })
    const foreignThumbnail = await app.request(
      `/documents/${document.id}/thumbnail`,
      { headers: { Cookie: strangerCookie } }
    )
    const foreignDelete = await app.request(`/documents/${document.id}`, {
      method: 'DELETE',
      headers: { Cookie: strangerCookie },
    })
    const missingDelete = await app.request(`/documents/${randomUUID()}`, {
      method: 'DELETE',
      headers: { Cookie: ownerCookie },
    })
    const unauthenticatedDelete = await app.request(
      `/documents/${document.id}`,
      { method: 'DELETE' }
    )
    const foreignQuery = await app.request('/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: strangerCookie,
      },
      body: JSON.stringify({
        documentId: document.id,
        question: 'What does this document say?',
      }),
    })
    const foreignStream = await app.request('/query/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: strangerCookie,
      },
      body: JSON.stringify({
        documentId: document.id,
        question: 'What does this document say?',
      }),
    })

    assert.deepEqual(
      [
        foreignDocument.status,
        foreignPdf.status,
        foreignThumbnail.status,
        foreignJob.status,
        foreignDelete.status,
        missingDelete.status,
        unauthenticatedDelete.status,
        foreignQuery.status,
        foreignStream.status,
      ],
      [404, 404, 404, 404, 404, 404, 401, 404, 404]
    )
    assert.ok(await Documents.getById(document.id))

    const ownDocument = await app.request(`/documents/${document.id}`, {
      headers: { Cookie: ownerCookie },
    })
    const ownJob = await app.request(`/jobs/${job.id}`, {
      headers: { Cookie: ownerCookie },
    })
    const ownPdf = await app.request(`/documents/${document.id}/pdf`, {
      headers: { Cookie: ownerCookie },
    })
    const ownThumbnail = await app.request(
      `/documents/${document.id}/thumbnail`,
      { headers: { Cookie: ownerCookie } }
    )
    assert.equal(ownDocument.status, 200)
    assert.equal(ownJob.status, 200)
    assert.equal(ownPdf.status, 200)
    assert.equal(ownPdf.headers.get('Content-Type'), 'application/pdf')
    assert.equal(ownThumbnail.status, 200)
    assert.equal(ownThumbnail.headers.get('Content-Type'), 'image/png')

    const ownDelete = await app.request(`/documents/${document.id}`, {
      method: 'DELETE',
      headers: { Cookie: ownerCookie },
    })
    assert.equal(ownDelete.status, 200)
    assert.equal(await Documents.getById(document.id), null)
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      [owner.id, stranger.id],
    ])
  }
})
