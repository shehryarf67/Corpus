import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { extractTextRuns } from './extract.js'

const fixturePath = path.join(import.meta.dirname, '__fixtures__', 'test.pdf')

test('extractTextRuns pulls text runs with position and font metadata', async () => {
  const buffer = await readFile(fixturePath)
  const runs = await extractTextRuns(buffer)

  // A parsing failure that silently returns nothing is the main way this
  // module could break without throwing.
  assert.ok(runs.length > 0, 'expected at least one text run')

  for (const run of runs) {
    assert.ok(run.text.trim().length > 0, 'run text should not be blank')
    assert.ok(run.page >= 1, 'page number should be 1-indexed')
    assert.ok(run.fontSize > 0, 'font size should be a positive number')
    assert.ok(run.fontName.length > 0, 'font name should not be empty')
  }
})

test('extractTextRuns captures font size variation, not a flat baseline', async () => {
  const buffer = await readFile(fixturePath)
  const runs = await extractTextRuns(buffer)

  const sizes = runs.map((run) => run.fontSize).sort((a, b) => a - b)
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0
  const max = sizes[sizes.length - 1] ?? 0

  // If every run came back the same size, we'd have silently lost the
  // metadata that makes heading detection possible downstream.
  assert.ok(max > median * 1.3, 'expected some runs noticeably larger than the median (e.g. a title/heading)')
})
