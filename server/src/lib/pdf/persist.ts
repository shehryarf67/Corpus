import { Chunks, type ChunkRow, type NewChunk } from '../db.js'
import type { EmbeddedChunk } from './embed.js'

// pgvector accepts a vector through node-postgres as bracketed text, such
// as "[0.1,0.2,0.3]". The embedding model gives us number[] instead, so
// this is the runtime conversion that the NewChunk type alone cannot do.
export function formatEmbeddingForPgvector(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

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
