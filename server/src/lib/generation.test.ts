import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { chatStream, type ChatMessage } from './generation.js'

const originalFetch = globalThis.fetch
const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }]
const encoder = new TextEncoder()

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockOllamaResponse(parts: string[]): void {
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

async function collectStream(): Promise<string[]> {
  const pieces: string[] = []
  for await (const piece of chatStream(messages)) pieces.push(piece)
  return pieces
}

test('chatStream yields text from multiple NDJSON lines', async () => {
  mockOllamaResponse([
    '{"message":{"content":"AQ"},"done":false}\n',
    '{"message":{"content":"-BERT"},"done":false}\n',
    '{"message":{"content":""},"done":true}\n',
  ])

  assert.deepEqual(await collectStream(), ['AQ', '-BERT'])
})

test('chatStream reconstructs a JSON line split across network reads', async () => {
  mockOllamaResponse([
    '{"message":{"cont',
    'ent":"split text"},"done":false}\n',
  ])

  assert.deepEqual(await collectStream(), ['split text'])
})

test('chatStream processes a final JSON object without a newline', async () => {
  mockOllamaResponse(['{"message":{"content":"final text"},"done":true}'])

  assert.deepEqual(await collectStream(), ['final text'])
})

test('chatStream throws when Ollama sends a stream error', async () => {
  mockOllamaResponse(['{"error":"model stopped"}\n'])

  await assert.rejects(collectStream(), /Ollama stream failed: model stopped/)
})
