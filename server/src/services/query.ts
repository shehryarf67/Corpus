import { Chunks, Conversations, Documents, Messages } from '../lib/db.js'
import { embed } from '../lib/embeddings.js'
import { buildContext, type ContextSource } from '../lib/context.js'
import { chat, type ChatMessage } from '../lib/generation.js'
import {
  buildAnswerMessages,
  buildCitationRetryMessages,
  CITATION_CORRECTION_OPTIONS,
} from '../lib/prompt.js'
import { validateCitations } from '../lib/citations.js'
import { selectCitationPassages } from '../lib/citation-passages.js'
import { fuseWithRRF } from '../lib/rrf.js'
import { rerankChunks } from '../lib/reranker.js'
import { rewriteQuestion } from '../lib/rewrite.js'

const RETRIEVAL_CANDIDATE_LIMIT = 20
const RERANK_CANDIDATE_LIMIT = 15
const CONTEXT_SOURCE_LIMIT = 5
export const NO_SEARCHABLE_CONTENT_ANSWER =
  'I could not find any searchable content in this document.'

export type QueryResult = {
  answer: string
  sources: ContextSource[]
}

export type ConversationQueryResult = QueryResult & {
  conversationId: string
}

// Everything answer generation needs after conversation setup, rewriting,
// retrieval, reranking, context construction, and prompt construction finish.
// Both normal chat() and future chatStream() can consume the same preparation.
export type PreparedQuery = {
  conversationId: string
  messages: ChatMessage[]
  sources: ContextSource[]
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

// Prepare everything needed for final answer generation, but do not generate
// or save the assistant answer here. Keeping that boundary lets chat() and
// chatStream() share one retrieval and prompt-building pipeline.
export async function prepareQuery(
  documentId: string,
  question: string,
  userId: string,
  conversationId?: string
): Promise<PreparedQuery> {
  // This scoped lookup is the ownership gate for both normal and streaming
  // queries. A foreign document looks exactly like a missing document.
  const document = await Documents.getByIdForUser(documentId, userId)
  if (!document) {
    throw new QueryConversationError('Document not found', 404)
  }

  const conversation = conversationId
    ? await Conversations.getByIdForUser(conversationId, userId)
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

  // Loading history before saving the new question means the question does not
  // appear twice when both `history` and `question` are sent to the models.
  const history = await Messages.getRecentByConversationId(conversation.id)

  await Messages.create(conversation.id, 'user', question) // Save the new question to the conversation history.
  const rewrittenQuestion = await rewriteQuestion(question, history)

  // Keyword retrieval does not need the embedding, so it can run while the
  // local embedding model converts the rewritten search question into a vector.
  const [embeddings, keywordResults] = await Promise.all([
    embed([rewrittenQuestion], 'query'),
    Chunks.searchByKeyword(
      documentId,
      rewrittenQuestion,
      RETRIEVAL_CANDIDATE_LIMIT
    ),
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
  const rerankedResults = await rerankChunks(
    rewrittenQuestion,
    rerankCandidates
  )
  const contextChunks = rerankedResults.slice(0, CONTEXT_SOURCE_LIMIT)
  const { sources, context } = buildContext(contextChunks)

  // Retrieval used the standalone rewrite, but the answer prompt uses exactly
  // what the user asked plus prior history and the retrieved document context.
  const messages = buildAnswerMessages(question, context, history)

  return {
    conversationId: conversation.id,
    messages,
    sources,
  }
}

// The current non-streaming query path now has one small job after preparation:
// generate the answer, validate it, save it, and return it to the route.
export async function queryConversation(
  documentId: string,
  question: string,
  userId: string,
  conversationId?: string
): Promise<ConversationQueryResult> {
  const prepared = await prepareQuery(
    documentId,
    question,
    userId,
    conversationId
  )

  if (prepared.sources.length === 0) {
    await Messages.create(
      prepared.conversationId,
      'assistant',
      NO_SEARCHABLE_CONTENT_ANSWER
    )

    return {
      conversationId: prepared.conversationId,
      answer: NO_SEARCHABLE_CONTENT_ANSWER,
      sources: [],
    }
  }

  const rawAnswer = await chat(prepared.messages)
  let validated = validateCitations(rawAnswer, prepared.sources)

  // Citations are model-written text, so the first answer can omit them or
  // invent a label. Retry exactly once with the same grounded prompt and the
  // first answer, asking Ollama only to correct its citation formatting.
  if (validated.sources.length === 0 || validated.invalidLabels.length > 0) {
    console.warn('Ollama returned missing or invalid citations; retrying once')

    const retryMessages = buildCitationRetryMessages(
      prepared.messages,
      rawAnswer,
      prepared.sources.map((source) => source.label)
    )
    const retryAnswer = await chat(retryMessages, CITATION_CORRECTION_OPTIONS)
    validated = validateCitations(retryAnswer, prepared.sources)
  }

  if (validated.invalidLabels.length > 0) {
    console.warn(
      `Ollama returned unknown citation labels: ${validated.invalidLabels.join(', ')}`
    )
  }

  const highlightedSources = selectCitationPassages(
    validated.answer,
    validated.sources,
    prepared.sources
  )

  await Messages.create(
    prepared.conversationId,
    'assistant',
    validated.answer,
    highlightedSources
  )

  return {
    conversationId: prepared.conversationId,
    answer: validated.answer,
    sources: highlightedSources,
  }
}
