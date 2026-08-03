import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Chunks, Documents, pool } from '../src/lib/db.js'
import type { EmbeddedChunk } from '../src/lib/pdf/embed.js'
import { persistEmbeddedChunks } from '../src/lib/pdf/persist.js'

const makeEmbedding = (seed: number): number[] =>
  Array.from({ length: 384 }, (_, i) => ((i + seed) % 100) / 100)

const makeEmbeddedChunk = (
  chunkIndex: number,
  overrides: Partial<EmbeddedChunk> = {}
): EmbeddedChunk => ({
  content: `Integration test chunk ${chunkIndex}`,
  page: 1,
  charStart: chunkIndex * 100,
  charEnd: chunkIndex * 100 + 50,
  chunkIndex,
  embedding: makeEmbedding(chunkIndex),
  ...overrides,
})

after(async () => {
  await pool.end()
})

test('persistEmbeddedChunks bulk inserts and retrieves real pgvector rows', async () => {
  let documentId: string | undefined

  try {
    const document = await Documents.create(
      'Persistence integration test',
      'persistence-test.pdf',
      'application/pdf',
      { test: true }
    )
    assert.ok(document)
    documentId = document.id

    const inserted = await persistEmbeddedChunks(documentId, [
      makeEmbeddedChunk(0),
      makeEmbeddedChunk(1, { page: 2 }),
    ])

    assert.equal(inserted.length, 2)
    assert.ok(inserted.every((row) => row.document_id === documentId))
    assert.ok(inserted.every((row) => typeof row.embedding === 'string'))

    const fetched = await Chunks.getByDocumentId(documentId)
    assert.deepEqual(fetched.map((row) => row.chunk_index), [0, 1])
    assert.deepEqual(fetched.map((row) => row.page_number), [1, 2])
    assert.deepEqual(
      fetched.map((row) => row.content),
      ['Integration test chunk 0', 'Integration test chunk 1']
    )

    await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    const afterCascadeDelete = await Chunks.getByDocumentId(documentId)
    assert.equal(afterCascadeDelete.length, 0)
    documentId = undefined
  } finally {
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    }
  }
})

test('a duplicate chunk index rejects the whole bulk insert', async () => {
  let documentId: string | undefined

  try {
    const document = await Documents.create(
      'Persistence rollback test',
      'rollback-test.pdf',
      'application/pdf',
      { test: true }
    )
    assert.ok(document)
    documentId = document.id

    await assert.rejects(
      persistEmbeddedChunks(documentId, [
        makeEmbeddedChunk(0),
        makeEmbeddedChunk(0, { content: 'Duplicate index' }),
      ])
    )

    const remaining = await Chunks.getByDocumentId(documentId)
    assert.equal(remaining.length, 0)
  } finally {
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    }
  }
})
