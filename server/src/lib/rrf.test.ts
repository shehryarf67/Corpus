import assert from 'node:assert/strict'
import test from 'node:test'
import type { KeywordRetrievedChunk, RetrievedChunk } from './db.js'
import { fuseWithRRF } from './rrf.js'

function vectorChunk(id: string, chunkIndex: number): RetrievedChunk {
  return {
    id,
    document_id: 'document-one',
    chunk_index: chunkIndex,
    content: `Chunk ${id}`,
    page_number: 1,
    char_start: chunkIndex * 10,
    char_end: chunkIndex * 10 + 5,
    similarity: 0.9 - chunkIndex * 0.1,
  }
}

function keywordChunk(id: string, chunkIndex: number): KeywordRetrievedChunk {
  return {
    id,
    document_id: 'document-one',
    chunk_index: chunkIndex,
    content: `Chunk ${id}`,
    page_number: 1,
    char_start: chunkIndex * 10,
    char_end: chunkIndex * 10 + 5,
    keyword_score: 1 - chunkIndex * 0.1,
  }
}

test('fuseWithRRF adds rank contributions and promotes chunks found by both searches', () => {
  const vectorResults = [
    vectorChunk('A', 0),
    vectorChunk('B', 1),
    vectorChunk('D', 2),
    vectorChunk('C', 3),
  ]
  const keywordResults = [keywordChunk('C', 3), keywordChunk('E', 4)]

  const fused = fuseWithRRF(vectorResults, keywordResults)
  const chunkC = fused.find((chunk) => chunk.id === 'C')

  assert.equal(fused[0]?.id, 'C')
  assert.equal(chunkC?.vectorPosition, 4)
  assert.equal(chunkC?.keywordPosition, 1)
  assert.ok(Math.abs((chunkC?.rrfScore ?? 0) - (1 / 64 + 1 / 61)) < 1e-12)
  assert.equal(fused.filter((chunk) => chunk.id === 'C').length, 1)
})

test('fuseWithRRF keeps chunks found by only one retrieval strategy', () => {
  const fused = fuseWithRRF(
    [vectorChunk('vector-only', 0)],
    [keywordChunk('keyword-only', 1)]
  )

  assert.deepEqual(
    fused.map((chunk) => chunk.id).sort(),
    ['keyword-only', 'vector-only']
  )
  assert.equal(
    fused.find((chunk) => chunk.id === 'vector-only')?.keywordPosition,
    null
  )
  assert.equal(
    fused.find((chunk) => chunk.id === 'keyword-only')?.vectorPosition,
    null
  )
})

test('fuseWithRRF does not mutate its input arrays', () => {
  const vectorResults = [vectorChunk('A', 0)]
  const keywordResults = [keywordChunk('A', 0)]
  const vectorCopy = structuredClone(vectorResults)
  const keywordCopy = structuredClone(keywordResults)

  fuseWithRRF(vectorResults, keywordResults)

  assert.deepEqual(vectorResults, vectorCopy)
  assert.deepEqual(keywordResults, keywordCopy)
})
