import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import type { Block } from './layout.js'
import { countTokens, groupIntoChunks, MAX_CHUNK_TOKENS } from './chunk.js'
import { layoutText } from './layout.js'

const fixturePath = path.join(import.meta.dirname, '__fixtures__', 'test.pdf')

// A small helper for building hand-crafted Block fixtures without a real
// PDF — this is exactly the benefit of keeping groupIntoChunks decoupled
// from layoutText: packing logic can be tested in isolation.
function makeBlock(overrides: Partial<Block>): Block {
  const text = overrides.text ?? ''
  return {
    type: 'paragraph',
    page: 1,
    charStart: 0,
    charEnd: text.length,
    ...overrides,
    text,
  }
}

function repeatSentences(count: number): string {
  return Array.from({ length: count }, (_, i) => `This is sentence number ${i}.`).join(' ')
}

test('small blocks on the same page get combined into one chunk', () => {
  const blocks = [
    makeBlock({ text: 'First short paragraph.', page: 1 }),
    makeBlock({ text: 'Second short paragraph.', page: 1 }),
  ]

  const chunks = groupIntoChunks(blocks)

  assert.equal(chunks.length, 1, 'expected both blocks to fit in a single chunk')
  assert.match(chunks[0]?.content ?? '', /First short paragraph\./)
  assert.match(chunks[0]?.content ?? '', /Second short paragraph\./)
})

test('a page change forces a new chunk even when the token budget would allow combining', () => {
  const blocks = [
    makeBlock({ text: 'Short text on page one.', page: 1 }),
    makeBlock({ text: 'Short text on page two.', page: 2 }),
  ]

  const chunks = groupIntoChunks(blocks)

  assert.equal(chunks.length, 2, 'expected a chunk boundary at the page change')
  assert.equal(chunks[0]?.page, 1)
  assert.equal(chunks[1]?.page, 2)
})

test('a table stays separate from surrounding prose', () => {
  const chunks = groupIntoChunks([
    makeBlock({ text: 'Paragraph before.', type: 'paragraph' }),
    makeBlock({
      text: 'Model | Size | Accuracy\nBERT | 324 | 93.5',
      type: 'table',
    }),
    makeBlock({ text: 'Paragraph after.', type: 'paragraph' }),
  ])

  assert.equal(chunks.length, 3)
  assert.equal(chunks[1]?.content, 'Model | Size | Accuracy\nBERT | 324 | 93.5')
})

test('oversized tables split by rows and repeat the header', () => {
  const header = 'Model | Size | Accuracy'
  const rows = Array.from(
    { length: 300 },
    (_, index) => `Model-${index} | ${index + 10} | ${(90 + index / 100).toFixed(2)}`
  )
  const chunks = groupIntoChunks([
    makeBlock({ text: [header, ...rows].join('\n'), type: 'table' }),
  ])

  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.content.startsWith(`${header}\n`))
    assert.ok(countTokens(chunk.content) <= MAX_CHUNK_TOKENS)
  }
})

test('no chunk exceeds the token budget, even when a block does', () => {
  const oversizedBlock = makeBlock({ text: repeatSentences(200), page: 1 })
  assert.ok(countTokens(oversizedBlock.text) > MAX_CHUNK_TOKENS, 'fixture block should actually be oversized')

  const chunks = groupIntoChunks([oversizedBlock])

  assert.ok(chunks.length > 1, 'expected the oversized block to be split into multiple chunks')
  for (const chunk of chunks) {
    assert.ok(countTokens(chunk.content) <= MAX_CHUNK_TOKENS, 'every split piece should respect the token budget')
    assert.equal(chunk.page, 1, 'split pieces should keep the original block\'s page')
  }
})

test('chunkIndex is sequential across normal and oversized chunks combined', () => {
  const blocks = [
    makeBlock({ text: 'A small paragraph before the big one.', page: 1 }),
    makeBlock({ text: repeatSentences(200), page: 1 }),
    makeBlock({ text: 'A small paragraph after the big one.', page: 1 }),
  ]

  const chunks = groupIntoChunks(blocks)

  chunks.forEach((chunk, i) => {
    assert.equal(chunk.chunkIndex, i, `expected chunkIndex ${i} at position ${i}`)
  })
})

test('against the real fixture: every chunk respects the token budget', async () => {
  const buffer = await readFile(fixturePath)
  const blocks = await layoutText(buffer)
  const chunks = groupIntoChunks(blocks)

  assert.ok(chunks.length > 0, 'expected at least one chunk')

  for (const chunk of chunks) {
    assert.ok(countTokens(chunk.content) <= MAX_CHUNK_TOKENS, 'chunk exceeded the token budget')
    assert.ok(chunk.content.trim().length > 0, 'chunk content should not be blank')
    assert.ok(chunk.page >= 1, 'page number should be 1-indexed')
    assert.ok(chunk.charEnd > chunk.charStart, 'charEnd should be after charStart')
  }
})
