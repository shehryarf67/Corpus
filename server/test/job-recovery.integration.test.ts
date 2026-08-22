import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { Documents, Jobs, Users, pool } from '../src/lib/db.js'

async function createDocument(label: string) {
  const user = await Users.create(
    `${label}-${randomUUID()}@example.test`,
    'not-a-real-password-hash'
  )
  if (!user) throw new Error('Failed to create recovery test user')

  const document = await Documents.create(
    user.id,
    label,
    `${label}.pdf`,
    'application/pdf',
    {}
  )
  if (!document) throw new Error('Failed to create recovery test document')
  return { user, document }
}

after(() => pool.end())

test('stale active jobs become failed while recently active jobs remain active', async () => {
  const { user, document } = await createDocument('abandoned-job')
  const staleJob = await Jobs.create(document.id)
  const freshJob = await Jobs.create(document.id)
  if (!staleJob || !freshJob) throw new Error('Failed to create recovery jobs')

  try {
    await Jobs.updateStatus(staleJob.id, 'embedding')
    await Jobs.updateStatus(freshJob.id, 'parsing')
    await pool.query(
      `UPDATE jobs
       SET updated_at = NOW() - INTERVAL '1 hour'
       WHERE id = $1`,
      [staleJob.id]
    )

    const recovered = await Jobs.failAbandoned(15 * 60_000)

    assert.deepEqual(recovered.map((job) => job.id), [staleJob.id])
    assert.equal((await Jobs.getById(staleJob.id))?.status, 'failed')
    assert.match(
      (await Jobs.getById(staleJob.id))?.error ?? '',
      /Retry this document/
    )
    assert.equal((await Jobs.getById(freshJob.id))?.status, 'parsing')
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [user.id])
  }
})

test('job cleanup removes old superseded attempts but preserves the latest attempt', async () => {
  const { user, document } = await createDocument('job-retention')
  const oldJob = await Jobs.create(document.id)
  const latestJob = await Jobs.create(document.id)
  if (!oldJob || !latestJob) throw new Error('Failed to create retention jobs')

  try {
    await Jobs.updateStatus(oldJob.id, 'done')
    await Jobs.updateStatus(latestJob.id, 'failed', 'Latest result stays visible')
    await pool.query(
      `UPDATE jobs
       SET created_at = CASE WHEN id = $1
           THEN NOW() - INTERVAL '100 days'
           ELSE NOW() - INTERVAL '95 days'
         END,
         updated_at = NOW() - INTERVAL '95 days'
       WHERE id IN ($1, $2)`,
      [oldJob.id, latestJob.id]
    )

    assert.equal(await Jobs.deleteOldTerminalAttempts(90), 1)
    assert.equal(await Jobs.getById(oldJob.id), null)
    assert.equal((await Jobs.getById(latestJob.id))?.status, 'failed')
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [user.id])
  }
})
