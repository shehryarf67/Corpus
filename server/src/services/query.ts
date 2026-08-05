import { Chunks, Conversations, Messages } from '../lib/db.js'
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

export type ConversationQueryResult = QueryResult & {
  conversationId: string
}

// The service uses this error when the request is valid JSON but the selected
// conversation cannot be used. The route turns its statusCode into an HTTP
// response without putting database workflow inside the route itself.
export class QueryConversationError extends Error {
  statusCode: 400 | 404

  constructor(message: string, statusCode: 400 | 404) {
    super(message)
    this.statusCode = statusCode
  }
}

// This service owns the complete conversation workflow. For a first message
// it creates a conversation; later requests load that same conversation.
export async function queryConversation(
  documentId: string,
  question: string,
  conversationId?: string
): Promise<ConversationQueryResult> {
  const conversation = conversationId
    ? await Conversations.getById(conversationId)
    : await Conversations.create(documentId)

  if (!conversation) {
    throw new QueryConversationError('Conversation not found', 404)
  }

  // A conversation is tied to one document. Mixing IDs would make history
  // from one document influence answers about a different document.
  if (conversation.document_id !== documentId) {
    throw new QueryConversationError(
      'Conversation does not belong to this document',
      400
    )
  }

  // We will pass this history to the query rewriter in the next step. Loading
  // it before saving the new question means the new question will not appear
  // twice when we supply both `history` and `question` to that helper.
  const history = await Messages.getByConversationId(conversation.id)

  await Messages.create(conversation.id, 'user', question) // Save the new question to the conversation history.
  const result = await queryDocument(documentId, question) // Generate an answer using the document's context and the question.
  await Messages.create(conversation.id, 'assistant', result.answer) // Save the generated answer to the conversation history.

  return {
    conversationId: conversation.id,
    ...result,
  }
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
