import { validateCitations } from '../lib/citations.js'
import type { ContextSource } from '../lib/context.js'
import { Messages } from '../lib/db.js'
import { chatStream } from '../lib/generation.js'
import {
  NO_SEARCHABLE_CONTENT_ANSWER,
  type PreparedQuery,
} from './query.js'

export type QueryStreamStatus = 'generating' | 'finalizing'

// The service produces normal TypeScript objects. The future SSE route will
// decide how these objects are written over HTTP.
export type QueryStreamEvent =
  | {
      type: 'conversation'
      conversationId: string
    }
  | {
      type: 'status'
      status: QueryStreamStatus
    }
  | {
      type: 'token'
      text: string
    }
  | {
      type: 'done'
      conversationId: string
      answer: string
      sources: ContextSource[]
    }

// Turn one prepared query into a sequence of application-level stream events.
// Errors are deliberately not caught here. chatStream(), citation validation,
// and database errors keep propagating so the future SSE route can send one
// transport-level error event without this service knowing anything about SSE.
export async function* streamPreparedQuery(
  prepared: PreparedQuery
): AsyncGenerator<QueryStreamEvent> {
  // Send the conversation ID first so a client can store a newly-created ID
  // before the answer has finished generating.
  yield {
    type: 'conversation',
    conversationId: prepared.conversationId,
  }

  yield {
    type: 'status',
    status: 'generating',
  }

  // Keep the same no-source behavior as the normal chat() path, but express
  // the fixed answer through the same token and done event sequence.
  if (prepared.sources.length === 0) {
    yield {
      type: 'token',
      text: NO_SEARCHABLE_CONTENT_ANSWER,
    }

    yield {
      type: 'status',
      status: 'finalizing',
    }

    await Messages.create(
      prepared.conversationId,
      'assistant',
      NO_SEARCHABLE_CONTENT_ANSWER
    )

    yield {
      type: 'done',
      conversationId: prepared.conversationId,
      answer: NO_SEARCHABLE_CONTENT_ANSWER,
      sources: [],
    }
    return
  }

  let rawAnswer = ''

  // Forward each Ollama text piece immediately while also keeping one complete
  // answer for citation validation and a single database message afterward.
  for await (const text of chatStream(prepared.messages)) {
    rawAnswer += text
    yield {
      type: 'token',
      text,
    }
  }

  yield {
    type: 'status',
    status: 'finalizing',
  }

  const validated = validateCitations(rawAnswer, prepared.sources)

  if (validated.invalidLabels.length > 0) {
    console.warn(
      `Ollama returned unknown citation labels: ${validated.invalidLabels.join(', ')}`
    )
  }

  // Do not save one row per token. Save only the complete validated answer.
  await Messages.create(
    prepared.conversationId,
    'assistant',
    validated.answer
  )

  // done means generation, validation, and database persistence all succeeded.
  yield {
    type: 'done',
    conversationId: prepared.conversationId,
    answer: validated.answer,
    sources: validated.sources,
  }
}
