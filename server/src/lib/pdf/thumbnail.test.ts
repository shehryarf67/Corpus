import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { loadImage } from '@napi-rs/canvas'
import { renderFirstPageThumbnail } from './thumbnail.js'

test('renderFirstPageThumbnail creates a card-sized PNG from page one', async () => {
  const pdf = await readFile(
    path.join(import.meta.dirname, '__fixtures__', 'test.pdf')
  )
  const thumbnail = await renderFirstPageThumbnail(pdf)
  const image = await loadImage(thumbnail)

  assert.equal(thumbnail.subarray(1, 4).toString(), 'PNG')
  assert.equal(image.width, 480)
  assert.ok(image.height > image.width)
})
