import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  prepareQuery,
  QueryConversationError,
  queryConversation,
} from '../services/query.js'
import { streamPreparedQuery } from '../services/query-stream.js'
import { requireAuth, type AuthEnv } from '../middleware/auth.js'

export const queryRoute = new Hono<AuthEnv>()

// This protects both normal and streaming query endpoints declared below.
queryRoute.use(requireAuth)

queryRoute.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { documentId, question, conversationId } = body

    if (typeof documentId !== 'string' || !documentId.trim()) {
      return c.json({ error: 'documentId is required' }, 400)
    }

    if (typeof question !== 'string' || !question.trim()) {
      return c.json({ error: 'question is required' }, 400)
    }

    // conversationId is absent for the first message and required for later
    // messages that should continue the same chat.
    if (
      conversationId !== undefined &&
      (typeof conversationId !== 'string' || !conversationId.trim())
    ) {
      return c.json({ error: 'conversationId must be a non-empty string' }, 400)
    }

    const result = await queryConversation(
      documentId.trim(),
      question.trim(),
      conversationId?.trim()
    )
    return c.json(result)
  } catch (error) {
    if (error instanceof QueryConversationError) {
      return c.json({ error: error.message }, error.statusCode)
    }

    console.error('query request failed', error)
    return c.json({ error: 'Query request failed' }, 500)
  }
})

queryRoute.post('/stream', async (c) => {
  try {
    const body = await c.req.json()
    const { documentId, question, conversationId } = body

    if (typeof documentId !== 'string' || !documentId.trim()) {
      return c.json({ error: 'documentId is required' }, 400)
    }

    if (typeof question !== 'string' || !question.trim()) {
      return c.json({ error: 'question is required' }, 400)
    }

    if (
      conversationId !== undefined &&
      (typeof conversationId !== 'string' || !conversationId.trim())
    ) {
      return c.json({ error: 'conversationId must be a non-empty string' }, 400)
    }

    // Preparation happens before the SSE response begins. This means invalid
    // conversations and preparation failures can still return normal HTTP
    // error responses instead of starting a stream that immediately fails.
    const prepared = await prepareQuery(
      documentId.trim(),
      question.trim(),
      conversationId?.trim()
    )

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of streamPreparedQuery(prepared)) {
          // The event name carries the type, while data contains only the
          // useful fields for that event. JSON.stringify keeps token newlines
          // and other special characters safe inside one SSE data value.
          const { type, ...data } = event
          await stream.writeSSE({
            event: type,
            data: JSON.stringify(data),
          })
        }
      } catch (error) {
        // Once SSE has started we cannot change the HTTP status code. Send a
        // final error event instead. The streaming service already avoided
        // saving a partial assistant answer when the error was thrown.
        console.error('query stream failed', error)
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: 'Query stream failed' }),
        })
      }
    })
  } catch (error) {
    if (error instanceof QueryConversationError) {
      return c.json({ error: error.message }, error.statusCode)
    }

    console.error('query stream preparation failed', error)
    return c.json({ error: 'Query stream preparation failed' }, 500)
  }
})
