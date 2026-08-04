import { Hono } from 'hono'
import { queryDocument } from '../services/query.js'

export const queryRoute = new Hono()

queryRoute.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { documentId, question } = body

    if (typeof documentId !== 'string' || !documentId.trim()) {
      return c.json({ error: 'documentId is required' }, 400)
    }

    if (typeof question !== 'string' || !question.trim()) {
      return c.json({ error: 'question is required' }, 400)
    }

    const result = await queryDocument(documentId, question.trim())
    return c.json(result)
  } catch (error) {
    console.error('query request failed', error)
    return c.json({ error: 'Query request failed' }, 500)
  }
})
