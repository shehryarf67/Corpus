import assert from 'node:assert/strict'
import test from 'node:test'
import { limitHistoryByTokens } from './history.js'
import { countTokens } from './tokens.js'

test('history budget keeps the newest contiguous messages', () => {
  const history = [
    { role: 'user' as const, content: 'old '.repeat(80) },
    { role: 'assistant' as const, content: 'middle answer' },
    { role: 'user' as const, content: 'newest question' },
  ]

  assert.deepEqual(limitHistoryByTokens(history, 20), history.slice(1))
})

test('an oversized newest message is truncated within the token budget', () => {
  const [message] = limitHistoryByTokens(
    [{ role: 'assistant' as const, content: 'important conclusion '.repeat(200) }],
    40
  )

  assert.ok(message)
  assert.match(message.content, /^\[Earlier content omitted\]/)
  assert.ok(countTokens(`${message.role}: ${message.content}`) + 2 <= 40)
})
