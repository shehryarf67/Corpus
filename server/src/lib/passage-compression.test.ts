import assert from 'node:assert/strict'
import test from 'node:test'
import { compressPassageForGeneration } from './passage-compression.js'

test('prose compression keeps the relevant sentence and its neighbours', () => {
  const content = [
    'Earlier context explains the experiment setup.',
    'The model reduces memory by assigning different bit widths to subgroups.',
    'This choice preserves accuracy during evaluation.',
    ...Array.from({ length: 30 }, (_, index) =>
      `Unrelated appendix sentence number ${index} discusses formatting details.`
    ),
  ].join(' ')

  const compressed = compressPassageForGeneration(
    content,
    'How does the model reduce memory?',
    55
  )

  assert.match(compressed, /experiment setup/)
  assert.match(compressed, /different bit widths/)
  assert.match(compressed, /preserves accuracy/)
  assert.ok(compressed.length < content.length)
})

test('table compression always keeps the header with matching rows', () => {
  const rows = [
    'Region | Requests | Approval rate',
    'North | 240 | 92 percent',
    ...Array.from({ length: 30 }, (_, index) =>
      `Region ${index} | ${100 + index} | 70 percent`
    ),
  ]
  const compressed = compressPassageForGeneration(
    rows.join('\n'),
    'What was the North approval rate?',
    40
  )

  assert.match(compressed, /^Region \| Requests \| Approval rate/m)
  assert.match(compressed, /North \| 240 \| 92 percent/)
})

test('compression keeps the full chunk when lexical evidence is uncertain', () => {
  const content = 'Individual subgroups select distinct bit widths. '.repeat(40)
  assert.equal(
    compressPassageForGeneration(
      content,
      'How does adaptive numerical precision reduce memory?'
    ),
    content
  )
})
