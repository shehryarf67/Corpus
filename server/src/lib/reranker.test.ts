import assert from 'node:assert/strict'
import test from 'node:test'
import type { FusedChunk } from './rrf.js'
import { attachRerankerScores, rerankChunks } from './reranker.js'

function fusedChunk(id: string, chunkIndex: number, rrfScore: number): FusedChunk {
  return {
    id,
    document_id: 'document-one',
    chunk_index: chunkIndex,
    content: `Chunk ${id}`,
    page_number: 1,
    char_start: chunkIndex * 10,
    char_end: chunkIndex * 10 + 5,
    similarity: 0.8,
    keywordScore: 0.5,
    vectorPosition: chunkIndex + 1,
    keywordPosition: chunkIndex + 1,
    rrfScore,
  }
}

test('attachRerankerScores sorts candidates by the new relevance score', () => {
  const candidates = [
    fusedChunk('A', 0, 0.04),
    fusedChunk('B', 1, 0.03),
    fusedChunk('C', 2, 0.02),
  ]

  const reranked = attachRerankerScores(candidates, [0.1, 2.4, -0.5])

  assert.deepEqual(
    reranked.map((chunk) => chunk.id),
    ['B', 'A', 'C']
  )
  assert.equal(reranked[0]?.rerankerScore, 2.4)
  assert.equal('rerankerScore' in candidates[0]!, false)
})

test('attachRerankerScores uses RRF as a stable tie-breaker', () => {
  const candidates = [
    fusedChunk('lower-rrf', 0, 0.02),
    fusedChunk('higher-rrf', 1, 0.04),
  ]

  const reranked = attachRerankerScores(candidates, [1, 1])

  assert.equal(reranked[0]?.id, 'higher-rrf')
})

test('attachRerankerScores rejects a missing model score', () => {
  assert.throws(
    () => attachRerankerScores([fusedChunk('A', 0, 0.04)], []),
    /returned 0 scores for 1 chunks/
  )
})

test('rerankChunks returns an empty array without loading the model', async () => {
  assert.deepEqual(await rerankChunks('Any question?', []), [])
})
