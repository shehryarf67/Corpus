import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContextSource } from './context.js'
import { selectCitationPassages } from './citation-passages.js'

function source(content: string): ContextSource {
  return {
    label: 'S1',
    chunkId: 'chunk-one',
    documentId: 'document-one',
    pageNumber: 2,
    content,
    similarity: 0.9,
  }
}

test('selects the supporting sentence instead of a nearby table heading', () => {
  const heading = 'Primitive. What the developer ships. What the user AI can change.'
  const supporting =
    'Users assisted by coding agents would assemble approved primitives into the interface they need.'
  const [result] = selectCitationPassages(
    'Users assemble approved primitives into the interface they need [S1].',
    [source(`${heading} ${supporting}`)]
  )

  assert.equal(result?.highlightText, supporting)
})

test('uses matching numbers to choose the correct passage', () => {
  const [result] = selectCitationPassages(
    'Increasing the group count from 128 to 768 produces a 0.1 percent gain [S1].',
    [
      source(
        'Increasing groups from 1 to 128 improves performance by at least 2 percent. ' +
        'Increasing groups from 128 to 768 produces only a 0.1 percent performance gain.'
      ),
    ]
  )

  assert.equal(
    result?.highlightText,
    'Increasing groups from 128 to 768 produces only a 0.1 percent performance gain.'
  )
})

test('returns no highlight when the chunk has no confident supporting passage', () => {
  const [result] = selectCitationPassages(
    'The application stores encrypted medical records [S1].',
    [source('Primitive. What the developer ships. Budget output cards.')]
  )

  assert.equal(result?.highlightText, null)
})

test('leaves fallback retrieval sources unhighlighted when no labelled claim exists', () => {
  const [result] = selectCitationPassages(
    'The answer contains no citation label.',
    [source('This passage happens to contain answer words.')]
  )

  assert.equal(result?.highlightText, null)
})

test('repairs a model label that points at the wrong retrieved chunk', () => {
  const wronglyCited = {
    ...source('Generic humanitarian operations overview.'),
    label: 'S4',
    chunkId: 'wrong-chunk',
    pageNumber: 3,
  }
  const actualEvidence = {
    ...source(
      'ReliefLens supports flood response, conflict displacement, drought response, and winterization campaigns.'
    ),
    label: 'S2',
    chunkId: 'supporting-chunk',
    pageNumber: 6,
  }

  const [result] = selectCitationPassages(
    'ReliefLens supports flood response, conflict displacement, drought response, and winterization campaigns [S4].',
    [wronglyCited],
    [wronglyCited, actualEvidence]
  )

  assert.equal(result?.label, 'S4')
  assert.equal(result?.chunkId, 'supporting-chunk')
  assert.equal(result?.pageNumber, 6)
  assert.equal(result?.highlightText, actualEvidence.content)
})
