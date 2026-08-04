import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCitations } from './citations.js'
import type { ContextSource } from './context.js'

const sources: ContextSource[] = [
  {
    label: 'S1',
    chunkId: 'chunk-one',
    documentId: 'document-one',
    pageNumber: 2,
    content: 'First source',
    similarity: 0.8,
  },
  {
    label: 'S4',
    chunkId: 'chunk-four',
    documentId: 'document-one',
    pageNumber: 3,
    content: 'Fourth source',
    similarity: 0.7,
  },
]

test('validateCitations keeps valid labels once and removes invented labels', () => {
  const result = validateCitations(
    'First claim [S1]. Invented claim [S99]. Another claim [S1].',
    sources
  )

  assert.equal(result.answer, 'First claim [S1]. Invented claim. Another claim [S1].')
  assert.deepEqual(result.sources.map((source) => source.label), ['S1'])
  assert.deepEqual(result.invalidLabels, ['S99'])
})

test('validateCitations normalizes Ollama source-id syntax before validation', () => {
  const result = validateCitations(
    'According to source id="S4", page=3, the framework uses two networks.',
    sources
  )

  assert.equal(result.answer, 'According to [S4], the framework uses two networks.')
  assert.deepEqual(result.sources.map((source) => source.label), ['S4'])
  assert.deepEqual(result.invalidLabels, [])
})

test('validateCitations returns no sources when the answer contains no citations', () => {
  const result = validateCitations('The answer contains no source marker.', sources)

  assert.equal(result.answer, 'The answer contains no source marker.')
  assert.deepEqual(result.sources, [])
  assert.deepEqual(result.invalidLabels, [])
})
