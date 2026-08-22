import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attributeAnswerSourcesWithFallback,
  selectCitationPassagesWithFallback,
  selectCrossEncoderChoice,
} from './citation-fallback.js'
import type { ContextSource } from './context.js'

const sources: ContextSource[] = [
  {
    label: 'S1',
    chunkId: 'chunk-one',
    documentId: 'document-one',
    pageNumber: 3,
    content: 'Each subgroup may use a distinct bit width selected by the search network.',
    similarity: 0.9,
  },
  {
    label: 'S2',
    chunkId: 'chunk-two',
    documentId: 'document-one',
    pageNumber: 8,
    content: 'The appendix describes the hardware and training schedule.',
    similarity: 0.8,
  },
]

test('cross-encoder choice rejects weak and ambiguous winners', () => {
  assert.equal(selectCrossEncoderChoice([0.4, -0.2]), null)
  assert.equal(selectCrossEncoderChoice([2, 1.6]), null)
})

test('cross-encoder choice accepts a strong, clear winner', () => {
  assert.deepEqual(selectCrossEncoderChoice([2.2, 0]), {
    sourceIndex: 0,
    score: 2.2,
  })
})

test('cross-encoder fallback attributes a heavily paraphrased claim', async () => {
  const attributed = await attributeAnswerSourcesWithFallback(
    'The method saves memory by giving parts of the model different numerical precision.',
    sources,
    async () => [2.4, -0.5]
  )

  assert.equal(attributed.length, 1)
  assert.equal(attributed[0]?.chunkId, 'chunk-one')
  // A semantic match identifies the supporting chunk, but not safe PDF words.
  assert.equal(attributed[0]?.highlightText, null)
})

test('unsupported claims do not receive the least-bad citation', async () => {
  const attributed = await attributeAnswerSourcesWithFallback(
    'The authors launched the system on Mars in 1997.',
    sources,
    async () => [0.2, -0.8]
  )

  assert.deepEqual(attributed, [])
})

test('valid-looking labels are corrected when only semantic evidence is strong', async () => {
  const selected = await selectCitationPassagesWithFallback(
    'Parts of the model receive different numerical precision. [S2]',
    [sources[1]!],
    sources,
    async () => [2.6, -0.4]
  )

  assert.equal(selected.length, 1)
  assert.equal(selected[0]?.label, 'S2')
  assert.equal(selected[0]?.chunkId, 'chunk-one')
  assert.equal(selected[0]?.highlightText, null)
})

test('valid-looking unsupported labels produce no source chip', async () => {
  const selected = await selectCitationPassagesWithFallback(
    'The system was deployed on Mars in 1997. [S1]',
    [sources[0]!],
    sources,
    async () => [0.3, 0.1]
  )

  assert.deepEqual(selected, [])
})
