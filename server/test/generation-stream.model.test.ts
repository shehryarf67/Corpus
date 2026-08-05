import assert from 'node:assert/strict'
import test from 'node:test'
import { chatStream, type ChatMessage } from '../src/lib/generation.js'

test('chatStream parses a real streamed Ollama response', async () => {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'Follow the user instruction exactly and do not add extra text.',
    },
    {
      role: 'user',
      content: 'Reply with exactly these words: stream parsing works correctly',
    },
  ]

  const pieces: string[] = []
  for await (const piece of chatStream(messages)) {
    pieces.push(piece)
  }

  const completeAnswer = pieces.join('').trim().toLowerCase()

  assert.ok(pieces.length > 0, 'Ollama should stream at least one text piece')
  assert.match(completeAnswer, /stream parsing works correctly/)
})
