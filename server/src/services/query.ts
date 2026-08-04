import { Chunks, type RetrievedChunk } from '../lib/db.js'
import { embed } from '../lib/embeddings.js'

export type QueryRetrievalResult = {
  sources: RetrievedChunk[]
}

// This service coordinates the query pipeline. For now that pipeline ends
// after retrieval. Context building, Ollama generation, and citations will
// be added here later, after we verify that retrieval itself is accurate.
export async function queryDocument(
  documentId: string,
  question: string
): Promise<QueryRetrievalResult> {
  // embed() accepts an array because it also supports batches. A query has
  // one question, so its vector is the first item in the returned array.
  const embeddings = await embed([question], 'query')
  const queryEmbedding = embeddings[0]

  if (!queryEmbedding) {
    throw new Error('Failed to create query embedding')
  }

  // Postgres compares this question vector with the stored chunk vectors
  // and returns only the five closest chunks for the selected document.
  const sources = await Chunks.searchSimilar(documentId, queryEmbedding, 5)

  return { sources }
}
