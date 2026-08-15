import { validateCitations } from '../lib/citations.js'
import { selectCitationPassages } from '../lib/citation-passages.js'
import type { ContextSource } from '../lib/context.js'
import { Messages } from '../lib/db.js'
import { chat, chatStream } from '../lib/generation.js'
import {
  buildCitationRetryMessages,
  CITATION_CORRECTION_OPTIONS,
} from '../lib/prompt.js'
import {
  logQueryTiming,
  timeQueryStage,
  timeSynchronousQueryStage,
} from '../lib/query-timing.js'
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

function comparableAnswerText(answer: string): string {
  // Ignore citation markers, punctuation, case, and whitespace when deciding
  // whether the correction changed the prose the user already watched stream.
  return (answer.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !/^S\d+$/i.test(word))
    .join(' ')
    .toLocaleLowerCase()
}

function materiallyDiffers(original: string, corrected: string): boolean {
  return comparableAnswerText(original) !== comparableAnswerText(corrected)
}

// Turn one prepared query into a sequence of application-level stream events.
// Errors are deliberately not caught here. chatStream(), citation validation,
// and database errors keep propagating so the future SSE route can send one
// transport-level error event without this service knowing anything about SSE.
export async function* streamPreparedQuery(
  prepared: PreparedQuery
): AsyncGenerator<QueryStreamEvent> {
  const { timing } = prepared

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

    yield {
      type: 'done',
      conversationId: prepared.conversationId,
      answer: NO_SEARCHABLE_CONTENT_ANSWER,
      sources: [],
    }
    return
  }

  let rawAnswer = ''
  const generationStartedAt = performance.now()
  let receivedFirstToken = false

  // Forward each Ollama text piece immediately while also keeping one complete
  // answer for citation validation and a single database message afterward.
  for await (const text of chatStream(prepared.messages)) {
    if (!receivedFirstToken) {
      logQueryTiming(timing, 'generation_first_token', generationStartedAt)
      receivedFirstToken = true
    }
    rawAnswer += text
    yield {
      type: 'token',
      text,
    }
  }
  logQueryTiming(timing, 'answer_generation', generationStartedAt)

  yield {
    type: 'status',
    status: 'finalizing',
  }

  let validated = timeSynchronousQueryStage(
    timing,
    'citation_validation',
    () => validateCitations(rawAnswer, prepared.sources)
  )
  let citationAnswer = validated.answer

  // Tokens have already reached the browser, so do not stream a second answer.
  // Instead, ask once for corrected labels and use that response to choose the
  // source chips carried by the final done event.
  if (validated.sources.length === 0 || validated.invalidLabels.length > 0) {
    console.warn('Ollama returned missing or invalid stream citations; correcting once')

    try {
      const correctionMessages = buildCitationRetryMessages(
        prepared.messages,
        rawAnswer,
        prepared.sources.map((source) => source.label)
      )
      const correctedAnswer = await timeQueryStage(
        timing,
        'citation_correction',
        () => chat(correctionMessages, CITATION_CORRECTION_OPTIONS)
      )
      const corrected = timeSynchronousQueryStage(
        timing,
        'citation_revalidation',
        () => validateCitations(correctedAnswer, prepared.sources)
      )

      if (corrected.sources.length > 0) {
        // Keep the labelled correction internally even when its prose is not
        // sent to the browser. It tells passage selection which claim used each
        // source label.
        citationAnswer = corrected.answer
        // Usually the correction only adds [S#] markers. Keep the prose already
        // visible in the browser in that case, and update only its source chips.
        // If Ollama genuinely rewrote the wording, done.answer remains the
        // authoritative final version and the frontend replaces the draft once.
        validated = {
          answer: materiallyDiffers(validated.answer, corrected.answer)
            ? corrected.answer
            : validated.answer,
          sources: corrected.sources,
          invalidLabels: corrected.invalidLabels,
        }
      } else {
        // The answer was generated from these retrieved chunks. Preserve them
        // as fallback source metadata instead of making every source disappear
        // because the small local model failed citation formatting twice.
        validated = {
          ...validated,
          sources:
            validated.sources.length > 0
              ? validated.sources
              : prepared.sources,
        }
        console.warn('Citation correction returned no valid labels; using retrieved sources')
      }
    } catch (error) {
      // Citation correction is an enhancement after a complete answer already
      // exists. A correction timeout must not turn that successful stream into
      // an error; finish with the retrieved source metadata instead.
      console.warn('Citation correction failed; using retrieved sources', error)
      validated = {
        ...validated,
        sources:
          validated.sources.length > 0
            ? validated.sources
            : prepared.sources,
      }
    }
  }

  if (validated.invalidLabels.length > 0) {
    console.warn(
      `Ollama returned unknown citation labels: ${validated.invalidLabels.join(', ')}`
    )
  }

  const highlightedSources = timeSynchronousQueryStage(
    timing,
    'passage_selection',
    () =>
      selectCitationPassages(
        citationAnswer,
        validated.sources,
        prepared.sources
      )
  )

  // Do not save one row per token. Save only the complete validated answer.
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

  // done means generation, validation, and database persistence all succeeded.
  yield {
    type: 'done',
    conversationId: prepared.conversationId,
    answer: validated.answer,
    sources: highlightedSources,
  }
}
