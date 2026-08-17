import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024
const PDF_SIGNATURE = Buffer.from('%PDF-')
const STORAGE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i

export function getPdfStorageDirectory(): string {
  return path.resolve(
    process.env.PDF_STORAGE_DIR ?? path.join(import.meta.dirname, '..', '..', 'data', 'uploads')
  )
}

function getMaxPdfSizeBytes(): number {
  const configured = Number(process.env.MAX_PDF_SIZE_BYTES)
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_PDF_SIZE_BYTES
}

function validatePdf(fileBuffer: Buffer): void {
  if (fileBuffer.length === 0) {
    throw new Error('PDF file is empty')
  }

  if (fileBuffer.length > getMaxPdfSizeBytes()) {
    throw new Error(`PDF exceeds the maximum size of ${getMaxPdfSizeBytes()} bytes`)
  }

  if (!fileBuffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    throw new Error('File does not have a valid PDF signature')
  }
}

function resolveStoragePath(storageKey: string): string {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new Error('Invalid PDF storage key')
  }

  return path.join(getPdfStorageDirectory(), storageKey)
}

export async function savePdf(fileBuffer: Buffer): Promise<string> {
  validatePdf(fileBuffer)

  const storageDirectory = getPdfStorageDirectory()
  await mkdir(storageDirectory, { recursive: true })

  const storageKey = `${randomUUID()}.pdf`
  const finalPath = resolveStoragePath(storageKey)
  const temporaryPath = `${finalPath}.tmp`

  try {
    await writeFile(temporaryPath, fileBuffer, { flag: 'wx' })
    await rename(temporaryPath, finalPath)
    return storageKey
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

export async function readPdf(storageKey: string): Promise<Buffer> {
  return readFile(resolveStoragePath(storageKey))
}

export async function pdfExists(storageKey: string): Promise<boolean> {
  try {
    // stat also confirms the key resolves to a real file rather than merely an
    // existing directory with an unexpected name.
    return (await stat(resolveStoragePath(storageKey))).isFile()
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

export async function deletePdf(storageKey: string): Promise<void> {
  await rm(resolveStoragePath(storageKey), { force: true })
}
