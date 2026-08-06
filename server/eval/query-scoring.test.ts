import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateFactCoverage,
  hasCanonicalCitation,
  looksLikeRefusal,
} from './query-scoring.js'

test('calculateFactCoverage accepts wording alternatives', () => {
  const coverage = calculateFactCoverage(
    'The tasks were SST-2, MNLI, CoNLL-03, and SQuAD.',
    [['SST-2'], ['MNLI'], ['CoNLL-2003', 'CoNLL-03'], ['SQuAD']]
  )
  assert.equal(coverage, 1)
})

test('calculateFactCoverage reports partial coverage', () => {
  assert.equal(
    calculateFactCoverage('It used SST-2 and MNLI.', [
      ['SST-2'],
      ['MNLI'],
      ['SQuAD'],
      ['CoNLL-2003'],
    ]),
    0.5
  )
})

test('refusal and citation helpers detect common output forms', () => {
  assert.equal(looksLikeRefusal('That GPU is not specified in the document.'), true)
  assert.equal(hasCanonicalCitation('The result is supported [S2].'), true)
  assert.equal(hasCanonicalCitation('No citation here.'), false)
})
