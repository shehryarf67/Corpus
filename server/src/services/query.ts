import { Chunks } from '../lib/db.js'
import { embed } from '../lib/embeddings.js'
import { buildContext, type ContextSource } from '../lib/context.js'
import { chat } from '../lib/generation.js'
import { buildAnswerMessages } from '../lib/prompt.js'
import { validateCitations } from '../lib/citations.js'
import { fuseWithRRF } from '../lib/rrf.js'

const RETRIEVAL_CANDIDATE_LIMIT = 20
const CONTEXT_SOURCE_LIMIT = 5

export type QueryResult = {
  answer: string
  sources: ContextSource[]
}

// This service coordinates retrieval, context construction, generation, and
// citation validation for one document question.
export async function queryDocument(
  documentId: string,
  question: string
): Promise<QueryResult> {
  // Keyword retrieval does not need the embedding, so it can run while the
  // local embedding model converts the question into a vector.
  const [embeddings, keywordResults] = await Promise.all([
    embed([question], 'query'),
    Chunks.searchByKeyword(documentId, question, RETRIEVAL_CANDIDATE_LIMIT),
  ])
  const queryEmbedding = embeddings[0]

  if (!queryEmbedding) {
    throw new Error('Failed to create query embedding')
  }

  const vectorResults = await Chunks.searchSimilar(
    documentId,
    queryEmbedding,
    RETRIEVAL_CANDIDATE_LIMIT
  )

  // RRF combines positions rather than incompatible raw score scales. Keep a
  // broad candidate set for recall, then give only the fused top five to the
  // context builder and Ollama.
  const fusedResults = fuseWithRRF(vectorResults, keywordResults)
  const contextChunks = fusedResults.slice(0, CONTEXT_SOURCE_LIMIT)
  const { sources, context } = buildContext(contextChunks)

  if (sources.length === 0) {
    return {
      answer: 'I could not find any searchable content in this document.',
      sources: [],
    }
  }

  // The prompt builder combines grounding instructions, labelled context,
  // and the user's question into the messages expected by Ollama.
  const messages = buildAnswerMessages(question, context)
  const rawAnswer = await chat(messages)
  const validated = validateCitations(rawAnswer, sources)

  if (validated.invalidLabels.length > 0) {
    console.warn(
      `Ollama returned unknown citation labels: ${validated.invalidLabels.join(', ')}`
    )
  }

  return {
    answer: validated.answer,
    sources: validated.sources,
  }
}
