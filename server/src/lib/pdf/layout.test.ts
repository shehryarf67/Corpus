import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { groupIntoSections, layoutText, type Line } from './layout.js'

const fixturePath = path.join(import.meta.dirname, '__fixtures__', 'test.pdf')

test('layoutText produces well-formed blocks', async () => {
  const buffer = await readFile(fixturePath)
  const blocks = await layoutText(buffer)

  assert.ok(blocks.length > 0, 'expected at least one block')

  for (const block of blocks) {
    assert.ok(block.text.trim().length > 0, 'block text should not be blank')
    assert.ok(block.page >= 1, 'page number should be 1-indexed')
    assert.ok(block.charStart >= 0, 'charStart should not be negative')
    assert.ok(block.charEnd > block.charStart, 'charEnd should be after charStart')
    assert.ok(
      block.type === 'heading' || block.type === 'paragraph' || block.type === 'table',
      'type should be heading, paragraph, or table'
    )
  }
})

function makeLine(
  text: string,
  y: number,
  cells: Array<{ text: string; minX: number; maxX: number }>
): Line {
  return {
    text,
    page: 1,
    y,
    fontSize: 10,
    minX: cells[0]?.minX ?? 50,
    maxX: cells.at(-1)?.maxX ?? 500,
    cells,
  }
}

test('aligned multi-cell rows become a separate readable table section', () => {
  const sections = groupIntoSections([
    makeLine('The paragraph before the table.', 740, [
      { text: 'The paragraph before the table.', minX: 50, maxX: 220 },
    ]),
    makeLine('Model Size Accuracy', 710, [
      { text: 'Model', minX: 50, maxX: 90 },
      { text: 'Size', minX: 210, maxX: 240 },
      { text: 'Accuracy', minX: 360, maxX: 420 },
    ]),
    makeLine('BERT 324 93.5', 696, [
      { text: 'BERT', minX: 50, maxX: 85 },
      { text: '324', minX: 210, maxX: 235 },
      { text: '93.5', minX: 360, maxX: 390 },
    ]),
    makeLine('Q-BERT 30 92.5', 682, [
      { text: 'Q-BERT', minX: 50, maxX: 100 },
      { text: '30', minX: 210, maxX: 225 },
      { text: '92.5', minX: 360, maxX: 390 },
    ]),
    makeLine('The paragraph after the table.', 650, [
      { text: 'The paragraph after the table.', minX: 50, maxX: 220 },
    ]),
  ])

  assert.deepEqual(sections.map((section) => section.type), [
    'text',
    'table',
    'text',
  ])
  assert.equal(
    sections[1]?.text,
    'Model | Size | Accuracy\nBERT | 324 | 93.5\nQ-BERT | 30 | 92.5'
  )
})

test('ordinary two-column prose is not classified as a table', () => {
  const sections = groupIntoSections([
    makeLine('Left paragraph Right paragraph', 700, [
      { text: 'Left paragraph', minX: 50, maxX: 160 },
      { text: 'Right paragraph', minX: 320, maxX: 440 },
    ]),
    makeLine('Left continuation Right continuation', 686, [
      { text: 'Left continuation', minX: 50, maxX: 170 },
      { text: 'Right continuation', minX: 320, maxX: 450 },
    ]),
  ])

  assert.deepEqual(sections.map((section) => section.type), ['text'])
})

test('the real fixture produces at least one table block', async () => {
  const buffer = await readFile(fixturePath)
  const blocks = await layoutText(buffer)

  assert.ok(blocks.some((block) => block.type === 'table'))
})

test('char offsets reset at the start of each page', async () => {
  const buffer = await readFile(fixturePath)
  const blocks = await layoutText(buffer)

  const seenPages = new Set<number>()
  for (const block of blocks) {
    if (!seenPages.has(block.page)) {
      seenPages.add(block.page)
      assert.equal(block.charStart, 0, `first block on page ${block.page} should start at offset 0`)
    }
  }
})

test('the real document title is detected as a heading', async () => {
  const buffer = await readFile(fixturePath)
  const blocks = await layoutText(buffer)

  const headings = blocks.filter((b) => b.type === 'heading')
  const hasTitle = headings.some((h) => h.text.includes('Automatic Mixed-Precision Quantization Search of BERT'))

  assert.ok(hasTitle, 'expected the paper title to be classified as a heading')
})

test('column bleed-through does not produce a garbled heading', async () => {
  // This document's body is two-column. Before column-aware reordering,
  // a fragment from the abstract's second column merged with a rotated
  // arXiv watermark run (a large font size), producing a bogus "heading"
  // block that mixed unrelated text together.
  const buffer = await readFile(fixturePath)
  const blocks = await layoutText(buffer)

  const hasGarbledBlock = blocks.some(
    (b) => b.text.includes('arXiv:2112.14938') && b.text.includes('outperforms baselines')
  )

  assert.ok(!hasGarbledBlock, 'expected no block to merge the watermark text with unrelated abstract text')
})
