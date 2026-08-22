import { Chunks, Conversations, Documents, Messages } from '../lib/db.js'
import { embed } from '../lib/embeddings.js'
import { buildContext, type ContextSource } from '../lib/context.js'
import { chat, type ChatMessage } from '../lib/generation.js'
import { buildAnswerMessages } from '../lib/prompt.js'
import { validateCitations } from '../lib/citations.js'
import {
  attributeAnswerSourcesWithFallback,
  selectCitationPassagesWithFallback,
} from '../lib/citation-fallback.js'
import { fuseWithRRF } from '../lib/rrf.js'
import { rerankChunks } from '../lib/reranker.js'
import { rewriteQuestion } from '../lib/rewrite.js'
import {
  HISTORY_MESSAGE_LIMIT,
  HISTORY_TOKEN_BUDGET,
  limitHistoryByTokens,
} from '../lib/history.js'
import {
  logQueryTiming,
  startQueryTiming,
  timeQueryStage,
  timeSynchronousQueryStage,
  type QueryTiming,
} from '../lib/query-timing.js'

const RETRIEVAL_CANDIDATE_LIMIT = 20
const RERANK_CANDIDATE_LIMIT = 15
// Retrieval still considers a broad candidate set, but only the three strongest
// reranked chunks enter the generation prompt. On the current evaluation set,
// every expected chunk ranks in the top two; using three cuts the measured
// prompt by about 35% without reducing retrieval recall for those cases.
const CONTEXT_SOURCE_LIMIT = 3
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
  timing?: QueryTiming
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
  const timing = startQueryTiming()

  // This scoped lookup is the ownership gate for both normal and streaming
  // queries. A foreign document looks exactly like a missing document.
  const document = await timeQueryStage(timing, 'document_ownership', () =>
    Documents.getByIdForUser(documentId, userId)
  )
  if (!document) {
    throw new QueryConversationError('Document not found', 404)
  }

  const conversation = await timeQueryStage(timing, 'conversation_setup', () =>
    conversationId
      ? Conversations.getByIdForUser(conversationId, userId)
      : Conversations.create(documentId)
  )

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
  const history = await timeQueryStage(timing, 'history_load', () =>
    Messages.getRecentByConversationId(conversation.id, HISTORY_MESSAGE_LIMIT)
      .then((messages) => limitHistoryByTokens(messages, HISTORY_TOKEN_BUDGET))
  )

  await timeQueryStage(timing, 'user_message_save', () =>
    Messages.create(conversation.id, 'user', question)
  )
  const rewrittenQuestion = await timeQueryStage(timing, 'question_rewrite', () =>
    rewriteQuestion(question, history)
  )

  // Keyword retrieval does not need the embedding, so it can run while the
  // local embedding model converts the rewritten search question into a vector.
  const [embeddings, keywordResults] = await Promise.all([
    timeQueryStage(timing, 'query_embedding', () =>
      embed([rewrittenQuestion], 'query')
    ),
    timeQueryStage(timing, 'keyword_retrieval', () =>
      Chunks.searchByKeyword(
        documentId,
        rewrittenQuestion,
        RETRIEVAL_CANDIDATE_LIMIT
      )
    ),
  ])
  const queryEmbedding = embeddings[0]

  if (!queryEmbedding) {
    throw new Error('Failed to create query embedding')
  }

  const vectorResults = await timeQueryStage(timing, 'vector_retrieval', () =>
    Chunks.searchSimilar(
      documentId,
      queryEmbedding,
      RETRIEVAL_CANDIDATE_LIMIT
    )
  )

  // RRF gives us a broad candidate list using both retrieval signals. The
  // cross-encoder then reads the question together with each of the best 15
  // candidates and sorts them by direct relevance. Only its top three become
  // generation context, keeping the final prompt focused.
  const fusedResults = timeSynchronousQueryStage(timing, 'rrf_fusion', () =>
    fuseWithRRF(vectorResults, keywordResults)
  )
  const rerankCandidates = fusedResults.slice(0, RERANK_CANDIDATE_LIMIT)
  const rerankedResults = await timeQueryStage(
    timing,
    'cross_encoder_rerank',
    () => rerankChunks(rewrittenQuestion, rerankCandidates)
  )
  const contextChunks = rerankedResults.slice(0, CONTEXT_SOURCE_LIMIT)
  const { sources, context } = timeSynchronousQueryStage(
    timing,
    'context_build',
    () => buildContext(contextChunks, rewrittenQuestion)
  )

  // Retrieval used the standalone rewrite, but the answer prompt uses exactly
  // what the user asked plus prior history and the retrieved document context.
  const messages = timeSynchronousQueryStage(timing, 'prompt_build', () =>
    buildAnswerMessages(question, context, history)
  )

  return {
    conversationId: conversation.id,
    messages,
    sources,
    timing,
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
  const { timing } = prepared

  if (prepared.sources.length === 0) {
    await timeQueryStage(timing, 'assistant_message_save', () =>
      Messages.create(
        prepared.conversationId,
        'assistant',
        NO_SEARCHABLE_CONTENT_ANSWER
      )
    )
    logQueryTiming(
      timing,
      'query_complete',
      timing?.startedAt ?? performance.now()
    )

    return {
      conversationId: prepared.conversationId,
      answer: NO_SEARCHABLE_CONTENT_ANSWER,
      sources: [],
    }
  }

  const rawAnswer = await timeQueryStage(timing, 'answer_generation', () =>
    chat(prepared.messages)
  )
  const validated = timeSynchronousQueryStage(
    timing,
    'citation_validation',
    () => validateCitations(rawAnswer, prepared.sources)
  )

  const needsLocalAttribution =
    validated.sources.length === 0 || validated.invalidLabels.length > 0

  if (needsLocalAttribution) {
    console.warn(
      'Ollama returned missing or invalid citations; attributing sources locally'
    )
  }

  if (validated.invalidLabels.length > 0) {
    console.warn(
      `Ollama returned unknown citation labels: ${validated.invalidLabels.join(', ')}`
    )
  }

  const highlightedSources = await timeQueryStage(
    timing,
    'passage_selection',
    () =>
      needsLocalAttribution
        ? attributeAnswerSourcesWithFallback(validated.answer, prepared.sources)
        : selectCitationPassagesWithFallback(
            validated.answer,
            validated.sources,
            prepared.sources
          )
  )

  await timeQueryStage(timing, 'assistant_message_save', () =>
    Messages.create(
      prepared.conversationId,
      'assistant',
      validated.answer,
      highlightedSources
    )
  )
  logQueryTiming(
    timing,
    'query_complete',
    timing?.startedAt ?? performance.now()
  )

  return {
    conversationId: prepared.conversationId,
    answer: validated.answer,
    sources: highlightedSources,
  }
}
