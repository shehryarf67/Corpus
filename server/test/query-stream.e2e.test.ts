import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Hono } from 'hono'
import { Documents, Messages, pool } from '../src/lib/db.js'
import { queryRoute } from '../src/routes/query.js'
import { createTestSessionCookie } from './auth-fixture.js'

type SSEEvent = {
  event: string
  data: Record<string, unknown>
}

after(async () => {
  await pool.end()
})

async function findTestDocumentId(): Promise<string> {
  if (process.env.E2E_DOCUMENT_ID) return process.env.E2E_DOCUMENT_ID

  const { rows } = await pool.query<{ id: string }>(
    `SELECT documents.id
     FROM documents
     JOIN chunks ON chunks.document_id = documents.id
     WHERE documents.filename IN ('test.pdf', 'test_pdf.pdf')
     GROUP BY documents.id, documents.uploaded_at
     ORDER BY documents.uploaded_at DESC
     LIMIT 1`
  )

  const document = rows[0]
  if (!document) {
    throw new Error(
      'No ingested test PDF was found. Set E2E_DOCUMENT_ID to an ingested document ID.'
    )
  }
  return document.id
}

function parseSSEBlock(block: string): SSEEvent {
  const lines = block.split('\n')
  const event = lines.find((line) => line.startsWith('event: '))?.slice(7)
  const dataLines = lines
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))

  if (!event || dataLines.length === 0) {
    throw new Error(`Invalid SSE block: ${block}`)
  }

  return {
    event,
    data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
  }
}

async function readSSE(response: Response): Promise<SSEEvent[]> {
  if (!response.body) throw new Error('SSE response did not contain a body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: SSEEvent[] = []
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      if (block.trim()) events.push(parseSSEBlock(block))
      boundary = buffer.indexOf('\n\n')
    }
  }

  buffer += decoder.decode()
  if (buffer.trim()) events.push(parseSSEBlock(buffer.trim()))
  reader.releaseLock()
  return events
}

test('real /query/stream sends incremental Ollama tokens and persists the final answer', async () => {
  const documentId = await findTestDocumentId()
  const document = await Documents.getById(documentId)
  if (!document) throw new Error('E2E document was not found')
  const sessionCookie = await createTestSessionCookie(document.user_id)
  const app = new Hono()
  app.route('/query', queryRoute)

  let conversationId: string | undefined

  try {
    const response = await app.request('/query/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({
        documentId,
        question: 'Which four NLP tasks are used to evaluate AQ-BERT?',
      }),
    })

    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)

    const events = await readSSE(response)
    assert.equal(events[0]?.event, 'conversation')
    assert.equal(events[1]?.event, 'status')
    assert.equal(events[1]?.data.status, 'generating')
    assert.equal(events.at(-2)?.event, 'status')
    assert.equal(events.at(-2)?.data.status, 'finalizing')
    assert.equal(events.at(-1)?.event, 'done')
    assert.equal(events.some((event) => event.event === 'error'), false)

    const tokenEvents = events.filter((event) => event.event === 'token')
    assert.ok(tokenEvents.length > 1, 'real Ollama should produce multiple token events')

    const streamedAnswer = tokenEvents
      .map((event) => String(event.data.text ?? ''))
      .join('')
    const done = events.at(-1)
    const finalAnswer = String(done?.data.answer ?? '')
    const finalSources = done?.data.sources

    // The done answer may normalize citations, but its factual content should
    // still match the evidence in page 5, chunk 12 of the ingested test PDF.
    for (const task of ['SST-2', 'MNLI', 'CoNLL-2003', 'SQuAD']) {
      assert.match(finalAnswer, new RegExp(task, 'i'))
    }
    assert.ok(streamedAnswer.length > 0)
    assert.ok(Array.isArray(finalSources), 'done must include source metadata')
    assert.ok(finalSources.length > 0, 'the grounded answer must cite a source')

    conversationId = String(events[0]?.data.conversationId ?? '')
    assert.ok(conversationId)
    assert.equal(done?.data.conversationId, conversationId)

    const storedMessages = await Messages.getByConversationId(conversationId)
    assert.deepEqual(
      storedMessages.map((message) => message.role),
      ['user', 'assistant']
    )
    assert.equal(storedMessages[1]?.content, finalAnswer)
    assert.ok(
      storedMessages[1]?.sources.length,
      'persisted assistant message must keep its source metadata'
    )
  } finally {
    if (conversationId) {
      await pool.query('DELETE FROM conversations WHERE id = $1', [conversationId])
    }
  }
})
