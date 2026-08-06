import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { ContextSource } from '../src/lib/context.js'
import { Conversations, Documents, Messages, pool } from '../src/lib/db.js'
import type { ChatMessage } from '../src/lib/generation.js'
import type { PreparedQuery } from '../src/services/query.js'
import {
  streamPreparedQuery,
  type QueryStreamEvent,
} from '../src/services/query-stream.js'

const originalFetch = globalThis.fetch
const encoder = new TextEncoder()

afterEach(() => {
  globalThis.fetch = originalFetch
})

after(async () => {
  await pool.end()
})

function mockOllama(parts: string[]): void {
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(encoder.encode(part))
          controller.close()
        },
      }),
      { status: 200 }
    )
}

async function collectEvents(prepared: PreparedQuery): Promise<QueryStreamEvent[]> {
  const events: QueryStreamEvent[] = []
  for await (const event of streamPreparedQuery(prepared)) events.push(event)
  return events
}

test('streamPreparedQuery emits events in order and saves one complete answer', async () => {
  let documentId: string | undefined

  try {
    const document = await Documents.create(
      'Streaming service integration test',
      'streaming-service-test.pdf',
      'application/pdf'
    )
    assert.ok(document)
    documentId = document.id

    const conversation = await Conversations.create(document.id)
    assert.ok(conversation)
    await Messages.create(conversation.id, 'user', 'Which planet is red?')

    const messages: ChatMessage[] = [
      { role: 'system', content: 'Answer from the supplied source.' },
      { role: 'user', content: 'Which planet is red?' },
    ]
    const sources: ContextSource[] = [
      {
        label: 'S1',
        chunkId: 'chunk-one',
        documentId: document.id,
        pageNumber: 1,
        content: 'Mars is known as the Red Planet.',
        similarity: 1,
      },
    ]
    const prepared: PreparedQuery = {
      conversationId: conversation.id,
      messages,
      sources,
    }

    mockOllama([
      '{"message":{"content":"Mars is known"},"done":false}\n',
      '{"message":{"content":" as the Red Planet [S1]."},"done":false}\n',
      '{"message":{"content":""},"done":true}\n',
    ])

    const events = await collectEvents(prepared)

    assert.deepEqual(
      events.map((event) => event.type),
      ['conversation', 'status', 'token', 'token', 'status', 'done']
    )
    assert.deepEqual(
      events
        .filter((event) => event.type === 'status')
        .map((event) => event.status),
      ['generating', 'finalizing']
    )
    assert.equal(events[0]?.type, 'conversation')
    if (events[0]?.type === 'conversation') {
      assert.equal(events[0].conversationId, conversation.id)
    }

    const done = events.at(-1)
    assert.equal(done?.type, 'done')
    if (done?.type === 'done') {
      assert.equal(done.answer, 'Mars is known as the Red Planet [S1].')
      assert.deepEqual(done.sources.map((source) => source.label), ['S1'])
    }

    const storedMessages = await Messages.getByConversationId(conversation.id)
    assert.deepEqual(
      storedMessages.map((message) => message.role),
      ['user', 'assistant']
    )
    assert.equal(
      storedMessages[1]?.content,
      'Mars is known as the Red Planet [S1].'
    )
  } finally {
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    }
  }
})

test('streamPreparedQuery handles no sources without calling Ollama', async () => {
  let documentId: string | undefined

  try {
    const document = await Documents.create(
      'No-source stream test',
      'no-source-stream-test.pdf',
      'application/pdf'
    )
    assert.ok(document)
    documentId = document.id

    const conversation = await Conversations.create(document.id)
    assert.ok(conversation)
    await Messages.create(conversation.id, 'user', 'Unknown question')

    globalThis.fetch = async () => {
      throw new Error('Ollama should not be called without sources')
    }

    const events = await collectEvents({
      conversationId: conversation.id,
      messages: [],
      sources: [],
    })

    assert.deepEqual(
      events.map((event) => event.type),
      ['conversation', 'status', 'token', 'status', 'done']
    )

    const storedMessages = await Messages.getByConversationId(conversation.id)
    assert.deepEqual(
      storedMessages.map((message) => message.role),
      ['user', 'assistant']
    )
  } finally {
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    }
  }
})

test('streamPreparedQuery propagates a stream error and does not save a partial answer', async () => {
  let documentId: string | undefined

  try {
    const document = await Documents.create(
      'Stream error test',
      'stream-error-test.pdf',
      'application/pdf'
    )
    assert.ok(document)
    documentId = document.id

    const conversation = await Conversations.create(document.id)
    assert.ok(conversation)
    await Messages.create(conversation.id, 'user', 'Question before failure')

    mockOllama([
      '{"message":{"content":"Partial answer"},"done":false}\n',
      '{"error":"model stopped"}\n',
    ])

    const prepared: PreparedQuery = {
      conversationId: conversation.id,
      messages: [{ role: 'user', content: 'Question before failure' }],
      sources: [
        {
          label: 'S1',
          chunkId: 'chunk-one',
          documentId: document.id,
          pageNumber: 1,
          content: 'Source content',
          similarity: 1,
        },
      ],
    }

    await assert.rejects(
      async () => collectEvents(prepared),
      /Ollama stream failed: model stopped/
    )

    const storedMessages = await Messages.getByConversationId(conversation.id)
    assert.deepEqual(
      storedMessages.map((message) => message.role),
      ['user']
    )
  } finally {
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    }
  }
})
