import { Documents, Jobs } from '../lib/db.js'
import { groupIntoChunks } from '../lib/pdf/chunk.js'
import { embedChunks } from '../lib/pdf/embed.js'
import { layoutText } from '../lib/pdf/layout.js'
import { persistEmbeddedChunks } from '../lib/pdf/persist.js'
import { readPdf } from '../lib/storage.js'

export type IngestionResult = {
  documentId: string
  chunkCount: number
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function processIngestionJob(jobId: string): Promise<IngestionResult> {
  const job = await Jobs.getById(jobId)
  if (!job) {
    throw new Error(`Ingestion job ${jobId} was not found`)
  }

  try {
    const document = await Documents.getById(job.document_id)
    if (!document) {
      throw new Error(`Document ${job.document_id} was not found`)
    }
    if (!document.storage_key) {
      throw new Error(`Document ${document.id} has no stored PDF`)
    }

    await Jobs.updateStatus(job.id, 'parsing')

    const fileBuffer = await readPdf(document.storage_key)
    const blocks = await layoutText(fileBuffer)
    const chunks = groupIntoChunks(blocks)

    if (chunks.length === 0) {
      throw new Error('PDF contains no extractable text')
    }

    await Jobs.updateStatus(job.id, 'embedding')

    const embeddedChunks = await embedChunks(chunks)
    const insertedChunks = await persistEmbeddedChunks(document.id, embeddedChunks)

    await Jobs.updateStatus(job.id, 'done')

    return {
      documentId: document.id,
      chunkCount: insertedChunks.length,
    }
  } catch (error) {
    await Jobs.updateStatus(job.id, 'failed', getErrorMessage(error))
    throw error
  }
}
