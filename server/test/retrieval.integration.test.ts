import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Chunks, Documents, pool } from '../src/lib/db.js'
import type { EmbeddedChunk } from '../src/lib/pdf/embed.js'
import { persistEmbeddedChunks } from '../src/lib/pdf/persist.js'

const testEmbedding = Array.from({ length: 384 }, (_, index) =>
  index === 0 ? 1 : 0
)

function makeChunk(chunkIndex: number, content: string): EmbeddedChunk {
  return {
    chunkIndex,
    content,
    page: chunkIndex + 1,
    charStart: chunkIndex * 100,
    charEnd: chunkIndex * 100 + content.length,
    embedding: testEmbedding,
  }
}

after(async () => {
  await pool.end()
})

test('searchByKeyword returns matching chunks from only the selected document', async () => {
  let selectedDocumentId: string | undefined
  let otherDocumentId: string | undefined

  try {
    const selectedDocument = await Documents.create(
      'Keyword retrieval test',
      'keyword-test.pdf',
      'application/pdf',
      { test: true }
    )
    const otherDocument = await Documents.create(
      'Keyword retrieval scope test',
      'other-keyword-test.pdf',
      'application/pdf',
      { test: true }
    )
    assert.ok(selectedDocument)
    assert.ok(otherDocument)
    selectedDocumentId = selectedDocument.id
    otherDocumentId = otherDocument.id

    await persistEmbeddedChunks(selectedDocumentId, [
      makeChunk(0, 'The super network controls bit assignment in the framework.'),
      makeChunk(1, 'The training dataset contains labelled examples.'),
    ])
    await persistEmbeddedChunks(otherDocumentId, [
      makeChunk(0, 'Another document also discusses bit assignment networks.'),
    ])

    const results = await Chunks.searchByKeyword(
      selectedDocumentId,
      'bit assignment network',
      10
    )

    assert.ok(results.length >= 1)
    assert.equal(results[0]?.document_id, selectedDocumentId)
    assert.equal(
      results[0]?.content,
      'The super network controls bit assignment in the framework.'
    )
    assert.ok((results[0]?.keyword_score ?? 0) > 0)
  } finally {
    if (selectedDocumentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [selectedDocumentId])
    }
    if (otherDocumentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [otherDocumentId])
    }
  }
})

test('searchByKeyword returns no candidates for an empty question', async () => {
  const results = await Chunks.searchByKeyword(
    '00000000-0000-0000-0000-000000000000',
    '   '
  )

  assert.deepEqual(results, [])
})

test('searchByKeyword handles a question containing only English stop words', async () => {
  const results = await Chunks.searchByKeyword(
    '00000000-0000-0000-0000-000000000000',
    'what is the'
  )

  assert.deepEqual(results, [])
})
