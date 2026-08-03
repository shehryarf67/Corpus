import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { Chunks, Documents, Jobs, pool } from '../src/lib/db.js'
import { deletePdf, savePdf } from '../src/lib/storage.js'
import { processIngestionJob } from '../src/services/ingestion.js'

let testStorageDirectory: string
let previousStorageDirectory: string | undefined

before(async () => {
  previousStorageDirectory = process.env.PDF_STORAGE_DIR
  testStorageDirectory = await mkdtemp(path.join(tmpdir(), 'corpus-ingestion-'))
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

test('processIngestionJob runs the complete stored-PDF ingestion pipeline', async () => {
  let documentId: string | undefined
  let storageKey: string | undefined

  try {
    const fixturePath = path.join(
      import.meta.dirname,
      '..',
      'src',
      'lib',
      'pdf',
      '__fixtures__',
      'test.pdf'
    )
    storageKey = await savePdf(await readFile(fixturePath))

    const document = await Documents.create(
      'Ingestion integration test',
      'test.pdf',
      'application/pdf',
      { test: true },
      storageKey
    )
    assert.ok(document)
    documentId = document.id

    const job = await Jobs.create(document.id)
    assert.ok(job)

    const result = await processIngestionJob(job.id)
    assert.equal(result.documentId, document.id)
    assert.ok(result.chunkCount > 0)

    const completedJob = await Jobs.getById(job.id)
    assert.equal(completedJob?.status, 'done')
    assert.equal(completedJob?.error, null)

    const storedChunks = await Chunks.getByDocumentId(document.id)
    assert.equal(storedChunks.length, result.chunkCount)
    assert.ok(storedChunks.every((chunk) => chunk.embedding !== null))
  } finally {
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    }
    if (storageKey) {
      await deletePdf(storageKey)
    }
  }
})

test('processIngestionJob marks the job failed when the document has no stored PDF', async () => {
  let documentId: string | undefined

  try {
    const document = await Documents.create(
      'Missing storage integration test',
      'missing.pdf',
      'application/pdf',
      { test: true }
    )
    assert.ok(document)
    documentId = document.id

    const job = await Jobs.create(document.id)
    assert.ok(job)

    await assert.rejects(processIngestionJob(job.id), /has no stored PDF/)

    const failedJob = await Jobs.getById(job.id)
    assert.equal(failedJob?.status, 'failed')
    assert.match(failedJob?.error ?? '', /has no stored PDF/)
  } finally {
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    }
  }
})
