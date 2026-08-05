import { Hono } from 'hono'
import {
  QueryConversationError,
  queryConversation,
} from '../services/query.js'

export const queryRoute = new Hono()

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
