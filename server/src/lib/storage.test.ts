import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { deletePdf, pdfExists, readPdf, savePdf } from './storage.js'

let testDirectory: string
let previousStorageDirectory: string | undefined

before(async () => {
  previousStorageDirectory = process.env.PDF_STORAGE_DIR
  testDirectory = await mkdtemp(path.join(tmpdir(), 'corpus-pdf-storage-'))
  process.env.PDF_STORAGE_DIR = testDirectory
})

after(async () => {
  if (previousStorageDirectory === undefined) {
    delete process.env.PDF_STORAGE_DIR
  } else {
    process.env.PDF_STORAGE_DIR = previousStorageDirectory
  }

  await rm(testDirectory, { recursive: true, force: true })
})

test('savePdf stores a valid PDF under a generated key', async () => {
  const pdf = Buffer.from('%PDF-1.7\nTest PDF content')
  const storageKey = await savePdf(pdf)

  assert.match(storageKey, /^[0-9a-f-]+\.pdf$/i)
  assert.equal(await pdfExists(storageKey), true)
  assert.deepEqual(await readPdf(storageKey), pdf)

  await deletePdf(storageKey)
  assert.equal(await pdfExists(storageKey), false)
  await assert.rejects(readPdf(storageKey))
})

test('savePdf rejects data without a PDF signature', async () => {
  await assert.rejects(savePdf(Buffer.from('not a pdf')), /valid PDF signature/)
})

test('storage functions reject unsafe storage keys', async () => {
  await assert.rejects(readPdf('../outside.pdf'), /Invalid PDF storage key/)
  await assert.rejects(pdfExists('../outside.pdf'), /Invalid PDF storage key/)
  await assert.rejects(deletePdf('document.pdf'), /Invalid PDF storage key/)
})
