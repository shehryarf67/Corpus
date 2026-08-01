import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Chunk } from './chunk.js'
import { embedChunks } from './embed.js'

function makeChunks(count: number): Chunk[] {
  return Array.from({ length: count }, (_, i) => ({
    content: `chunk number ${i}`,
    page: 1,
    charStart: i * 20,
    charEnd: i * 20 + 15,
    chunkIndex: i,
  }))
}

test('embedChunks produces well-formed output', async () => {
  const chunks = makeChunks(5)
  const result = await embedChunks(chunks)

  assert.equal(result.length, chunks.length, 'expected one embedded chunk per input chunk')

  for (const embedded of result) {
    assert.equal(embedded.embedding.length, 384, 'expected a 384-dimension vector')
    assert.ok(
      embedded.embedding.every((value) => typeof value === 'number' && !Number.isNaN(value)),
      'every embedding value should be a real number'
    )
  }
})

test('original chunk fields are preserved alongside the embedding', async () => {
  const chunks = makeChunks(3)
  const result = await embedChunks(chunks)

  result.forEach((embedded, i) => {
    assert.equal(embedded.content, chunks[i]?.content)
    assert.equal(embedded.page, chunks[i]?.page)
    assert.equal(embedded.charStart, chunks[i]?.charStart)
    assert.equal(embedded.charEnd, chunks[i]?.charEnd)
    assert.equal(embedded.chunkIndex, chunks[i]?.chunkIndex)
  })
})

test('ordering is preserved across a single batch', async () => {
  const chunks = makeChunks(10)
  const result = await embedChunks(chunks)

  result.forEach((embedded, i) => {
    assert.equal(embedded.chunkIndex, i, `expected chunkIndex ${i} at position ${i}`)
  })
})

test('ordering and count are preserved across the batch boundary (multi-batch)', async () => {
  // 40 exceeds BATCH_SIZE (32), forcing a second, smaller batch (8 chunks) —
  // this is the exact case that was never actually run until we checked it
  // by hand; keeping that check permanent here instead of a scratch script.
  const chunks = makeChunks(40)
  const result = await embedChunks(chunks)

  assert.equal(result.length, 40)
  result.forEach((embedded, i) => {
    assert.equal(embedded.chunkIndex, i)
    assert.equal(embedded.embedding.length, 384)
  })
})

test('distinct content produces distinct embeddings, not a flat/degenerate result', async () => {
  const chunks: Chunk[] = [
    { content: 'The stock market rose sharply today.', page: 1, charStart: 0, charEnd: 10, chunkIndex: 0 },
    { content: 'Photosynthesis converts sunlight into energy.', page: 1, charStart: 11, charEnd: 20, chunkIndex: 1 },
  ]
  const result = await embedChunks(chunks)
  const a = result[0]
  const b = result[1]
  assert.ok(a && b, 'expected two embedded chunks back')

  const distance = Math.sqrt(
    a.embedding.reduce((sum, value, i) => sum + (value - (b.embedding[i] ?? 0)) ** 2, 0)
  )

  assert.ok(distance > 0.1, 'two unrelated sentences should not produce near-identical vectors')
})
