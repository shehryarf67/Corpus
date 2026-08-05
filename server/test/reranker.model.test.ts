import assert from 'node:assert/strict'
import test from 'node:test'
import type { FusedChunk } from '../src/lib/rrf.js'
import { rerankChunks } from '../src/lib/reranker.js'

function candidate(id: string, content: string, chunkIndex: number): FusedChunk {
  return {
    id,
    document_id: 'reranker-smoke-test',
    chunk_index: chunkIndex,
    content,
    page_number: 1,
    char_start: 0,
    char_end: content.length,
    similarity: null,
    keywordScore: null,
    vectorPosition: null,
    keywordPosition: null,
    rrfScore: 0,
  }
}

test('real reranker promotes the passage that directly answers the question', async () => {
  const results = await rerankChunks('Which planet is known as the Red Planet?', [
    candidate('saturn', 'Saturn is famous for its large ring system.', 0),
    candidate('mars', 'Mars is commonly called the Red Planet.', 1),
  ])

  assert.equal(results[0]?.id, 'mars')
  assert.equal(results.length, 2)
  assert.notEqual(results[0]?.rerankerScore, results[1]?.rerankerScore)
})
