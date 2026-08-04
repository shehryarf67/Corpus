import { Chunks, type ChunkRow, type NewChunk } from '../db.js'
import { formatEmbeddingForPgvector } from '../vector.js'
import type { EmbeddedChunk } from './embed.js'

// Keep the existing export available to callers while the reusable helper
// itself now lives outside the PDF pipeline. Query retrieval needs the same
// number[] -> pgvector conversion as ingestion.
export { formatEmbeddingForPgvector } from '../vector.js'

// Convert the PDF pipeline's camelCase EmbeddedChunk objects into the
// database-ready NewChunk shape expected by Chunks.insertMany.
export function toNewChunks(embeddedChunks: EmbeddedChunk[]): NewChunk[] {
  return embeddedChunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    pageNumber: chunk.page,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    embedding: formatEmbeddingForPgvector(chunk.embedding),
  }))
}

// This is the persistence boundary for embedded chunks: map them into the
// database input shape, then bulk insert them under one document ID.
export async function persistEmbeddedChunks(
  documentId: string,
  embeddedChunks: EmbeddedChunk[]
): Promise<ChunkRow[]> {
  return Chunks.insertMany(documentId, toNewChunks(embeddedChunks))
}
