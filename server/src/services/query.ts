import { Chunks } from '../lib/db.js'
import { embed } from '../lib/embeddings.js'
import { buildContext, type ContextSource } from '../lib/context.js'
import { chat } from '../lib/generation.js'
import { buildAnswerMessages } from '../lib/prompt.js'

export type QueryResult = {
  answer: string
  sources: ContextSource[]
}

// This service coordinates the query pipeline. For now that pipeline ends
// after retrieval. Context building, Ollama generation, and citations will
// be added here later, after we verify that retrieval itself is accurate.
export async function queryDocument(
  documentId: string,
  question: string
): Promise<QueryResult> {
  // embed() accepts an array because it also supports batches. A query has
  // one question, so its vector is the first item in the returned array.
  const embeddings = await embed([question], 'query')
  const queryEmbedding = embeddings[0]

  if (!queryEmbedding) {
    throw new Error('Failed to create query embedding')
  }

  // Postgres compares this question vector with the stored chunk vectors
  // and returns only the five closest chunks for the selected document.
  const retrievedChunks = await Chunks.searchSimilar(documentId, queryEmbedding, 5)
  const {sources, context} = buildContext(retrievedChunks)

  if (sources.length === 0) {
    return {
      answer: 'I could not find any searchable content in this document.',
      sources: [],
    }
  }

  // The prompt builder combines grounding instructions, labelled context,
  // and the user's question into the messages expected by Ollama.
  const messages = buildAnswerMessages(question, context)
  const answer = await chat(messages)

  return { answer, sources }
}
