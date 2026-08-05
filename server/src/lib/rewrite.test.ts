import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRewriteMessages, rewriteQuestion } from './rewrite.js'

const history = [
  { role: 'user' as const, content: 'What is AQ-BERT?' },
  {
    role: 'assistant' as const,
    content: 'AQ-BERT is a mixed-precision quantization method.',
  },
]

test('buildRewriteMessages includes history and the follow-up question', () => {
  const messages = buildRewriteMessages('What tasks was it tested on?', history)

  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.role, 'system')
  assert.match(messages[0]?.content ?? '', /do not answer the question/i)
  assert.match(messages[1]?.content ?? '', /user: What is AQ-BERT\?/)
  assert.match(messages[1]?.content ?? '', /assistant: AQ-BERT is/)
  assert.match(messages[1]?.content ?? '', /What tasks was it tested on\?/)
})

test('rewriteQuestion returns the first question without calling Ollama', async () => {
  const question = 'What is AQ-BERT?'
  assert.equal(await rewriteQuestion(question, []), question)
})
