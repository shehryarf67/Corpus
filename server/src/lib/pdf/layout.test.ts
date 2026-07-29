import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { layoutText } from './layout.js'

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
    assert.ok(block.type === 'heading' || block.type === 'paragraph', 'type should be heading or paragraph')
  }
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
