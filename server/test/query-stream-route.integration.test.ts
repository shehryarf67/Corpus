import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { Hono } from 'hono'
import { Documents, Messages, pool } from '../src/lib/db.js'
import { embedChunks } from '../src/lib/pdf/embed.js'
import { persistEmbeddedChunks } from '../src/lib/pdf/persist.js'
import { queryRoute } from '../src/routes/query.js'

const originalFetch = globalThis.fetch
const encoder = new TextEncoder()

afterEach(() => {
  globalThis.fetch = originalFetch
})

after(async () => {
  await pool.end()
})

type ParsedSSEEvent = {
  event: string
  data: Record<string, unknown>
}

function parseSSE(text: string): ParsedSSEEvent[] {
  return text
    .trim()
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n')
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7)
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6)

      if (!event || !data) throw new Error(`Invalid SSE block: ${block}`)
      return { event, data: JSON.parse(data) as Record<string, unknown> }
    })
}

test('POST /query/stream translates service events into SSE', async () => {
  let documentId: string | undefined

  try {
    const document = await Documents.create(
      'Streaming route integration test',
      'streaming-route-test.pdf',
      'application/pdf'
    )
    assert.ok(document)
    documentId = document.id

    const embeddedChunks = await embedChunks([
      {
        chunkIndex: 0,
        content: 'Mars is commonly known as the Red Planet.',
        page: 1,
        charStart: 0,
        charEnd: 45,
      },
    ])
    await persistEmbeddedChunks(document.id, embeddedChunks)

    // Leave non-Ollama fetches untouched in case a local model needs them.
    // Only replace the final streamed /api/chat response used by chatStream().
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('http://localhost:11434/api/chat')) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  '{"message":{"content":"Mars is the Red Planet [S1]."},"done":false}\n'
                )
              )
              controller.enqueue(
                encoder.encode('{"message":{"content":""},"done":true}\n')
              )
              controller.close()
            },
          }),
          { status: 200 }
        )
      }
      return originalFetch(input, init)
    }

    const app = new Hono()
    app.route('/query', queryRoute)

    const response = await app.request('/query/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentId: document.id,
        question: 'Which planet is known as the Red Planet?',
      }),
    })

    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)

    const events = parseSSE(await response.text())
    assert.deepEqual(
      events.map((event) => event.event),
      ['conversation', 'status', 'token', 'status', 'done']
    )
    assert.equal(events[1]?.data.status, 'generating')
    assert.equal(events[2]?.data.text, 'Mars is the Red Planet [S1].')
    assert.equal(events[3]?.data.status, 'finalizing')
    assert.equal(events[4]?.data.answer, 'Mars is the Red Planet [S1].')

    const conversationId = events[0]?.data.conversationId
    assert.equal(typeof conversationId, 'string')
    const storedMessages = await Messages.getByConversationId(
      conversationId as string
    )
    assert.deepEqual(
      storedMessages.map((message) => message.role),
      ['user', 'assistant']
    )

    // After SSE has started, a stream failure must become an SSE error event.
    // The service should leave only the user message for this failed request.
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('http://localhost:11434/api/chat')) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode('{"error":"model stopped"}\n')
              )
              controller.close()
            },
          }),
          { status: 200 }
        )
      }
      return originalFetch(input, init)
    }

    const failedResponse = await app.request('/query/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentId: document.id,
        question: 'Ask a question that fails during generation',
      }),
    })
    const failedEvents = parseSSE(await failedResponse.text())

    assert.deepEqual(
      failedEvents.map((event) => event.event),
      ['conversation', 'status', 'error']
    )
    assert.equal(failedEvents[2]?.data.message, 'Query stream failed')

    const failedConversationId = failedEvents[0]?.data.conversationId
    assert.equal(typeof failedConversationId, 'string')
    const failedMessages = await Messages.getByConversationId(
      failedConversationId as string
    )
    assert.deepEqual(
      failedMessages.map((message) => message.role),
      ['user']
    )
  } finally {
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    }
  }
})
