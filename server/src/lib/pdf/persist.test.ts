import assert from 'node:assert/strict'
import test from 'node:test'
import type { EmbeddedChunk } from './embed.js'
import { formatEmbeddingForPgvector, toNewChunks } from './persist.js'

test('formatEmbeddingForPgvector converts number[] to bracketed pgvector text', () => {
  assert.equal(formatEmbeddingForPgvector([0.1, -0.2, 0.3]), '[0.1,-0.2,0.3]')
})

test('toNewChunks maps embedded chunks into the database input shape', () => {
  const embeddedChunks: EmbeddedChunk[] = [
    {
      content: 'A chunk of document text',
      page: 2,
      charStart: 10,
      charEnd: 34,
      chunkIndex: 0,
      embedding: [0.1, 0.2, 0.3],
    },
  ]

  assert.deepEqual(toNewChunks(embeddedChunks), [
    {
      content: 'A chunk of document text',
      pageNumber: 2,
      charStart: 10,
      charEnd: 34,
      chunkIndex: 0,
      embedding: '[0.1,0.2,0.3]',
    },
  ])
})

test('toNewChunks does not mutate the original embedded chunks', () => {
  const embeddedChunk: EmbeddedChunk = {
    content: 'Original content',
    page: 1,
    charStart: 0,
    charEnd: 16,
    chunkIndex: 0,
    embedding: [0.4, 0.5],
  }

  const originalCopy = structuredClone(embeddedChunk)
  toNewChunks([embeddedChunk])

  assert.deepEqual(embeddedChunk, originalCopy)
})
