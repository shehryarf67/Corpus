import { Chunks } from '../lib/db.js'
import { embed } from '../lib/embeddings.js'
import { buildContext, type ContextSource } from '../lib/context.js'
import { chat } from '../lib/generation.js'
import { buildAnswerMessages } from '../lib/prompt.js'
import { validateCitations } from '../lib/citations.js'
import { fuseWithRRF } from '../lib/rrf.js'
import { rerankChunks } from '../lib/reranker.js'

const RETRIEVAL_CANDIDATE_LIMIT = 20
const RERANK_CANDIDATE_LIMIT = 15
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

  // RRF gives us a broad candidate list using both retrieval signals. The
  // cross-encoder then reads the question together with each of the best 15
  // candidates and sorts them by direct relevance. Only its top five become
  // generation context, keeping the final prompt focused.
  const fusedResults = fuseWithRRF(vectorResults, keywordResults)
  const rerankCandidates = fusedResults.slice(0, RERANK_CANDIDATE_LIMIT)
  const rerankedResults = await rerankChunks(question, rerankCandidates)
  const contextChunks = rerankedResults.slice(0, CONTEXT_SOURCE_LIMIT)
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
