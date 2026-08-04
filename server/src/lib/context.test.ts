import assert from 'node:assert/strict'
import test from 'node:test'
import type { RetrievedChunk } from './db.js'
import { buildContext } from './context.js'

test('buildContext labels and formats retrieved chunks in ranking order', () => {
  const retrievedChunks: RetrievedChunk[] = [
    {
      id: 'chunk-one',
      document_id: 'document-one',
      chunk_index: 4,
      content: 'The inner network trains the model weights.',
      page_number: 3,
      char_start: 100,
      char_end: 143,
      similarity: 0.87,
    },
    {
      id: 'chunk-two',
      document_id: 'document-one',
      chunk_index: 8,
      content: 'The super network controls bit assignment.',
      page_number: null,
      char_start: 300,
      char_end: 342,
      similarity: 0.74,
    },
  ]

  const result = buildContext(retrievedChunks)

  assert.equal(
    result.context,
    '<source id="S1" page="3">\nThe inner network trains the model weights.\n</source>\n\n' +
      '<source id="S2" page="Unknown">\nThe super network controls bit assignment.\n</source>'
  )

  assert.deepEqual(result.sources, [
    {
      label: 'S1',
      chunkId: 'chunk-one',
      documentId: 'document-one',
      pageNumber: 3,
      content: 'The inner network trains the model weights.',
      similarity: 0.87,
    },
    {
      label: 'S2',
      chunkId: 'chunk-two',
      documentId: 'document-one',
      pageNumber: null,
      content: 'The super network controls bit assignment.',
      similarity: 0.74,
    },
  ])
})

test('buildContext returns empty context and sources for no retrieved chunks', () => {
  assert.deepEqual(buildContext([]), {
    context: '',
    sources: [],
  })
})
