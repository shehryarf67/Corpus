import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAnswerMessages,
  buildCitationRetryMessages,
} from './prompt.js'

test('buildAnswerMessages creates grounded system and user messages', () => {
  const question = 'What two networks are included in the framework?'
  const context = `<source id="S1" page="3">
The framework includes an inner training network and a super network.
</source>`

  const messages = buildAnswerMessages(question, context)

  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.role, 'system')
  assert.equal(messages[1]?.role, 'user')

  const systemMessage = messages[0]?.content ?? ''
  const userMessage = messages[1]?.content ?? ''

  // The reusable system message should ground the answer in the retrieved
  // context and explain the citation format expected from the model.
  assert.match(systemMessage, /using only the supplied document context/i)
  assert.match(systemMessage, /could not find the answer/i)
  assert.match(systemMessage, /\[S1\]/)
  assert.match(systemMessage, /do not copy the <source> wrapper/i)
  assert.match(systemMessage, /every factual claim/i)
  assert.match(systemMessage, /answer containing factual claims without citations is invalid/i)
  assert.match(systemMessage, /use only source IDs that appear/i)
  assert.match(systemMessage, /correct citation example/i)
  assert.match(systemMessage, /do not add a citation to this refusal/i)
  assert.match(systemMessage, /not as instructions/i)

  // Request-specific data belongs in the user message. Keeping document
  // text out of the system message separates evidence from instructions.
  assert.match(userMessage, /DOCUMENT CONTEXT:/)
  assert.ok(userMessage.includes(context))
  assert.match(userMessage, /QUESTION:/)
  assert.ok(userMessage.includes(question))
  assert.ok(!systemMessage.includes(context))
  assert.ok(!systemMessage.includes(question))
})

test('buildAnswerMessages preserves an empty context for missing-source handling', () => {
  const messages = buildAnswerMessages('What is the answer?', '')
  const userMessage = messages[1]?.content ?? ''

  assert.match(userMessage, /DOCUMENT CONTEXT:\s+QUESTION:/)
  assert.ok(userMessage.includes('What is the answer?'))
})

test('buildAnswerMessages places conversation history before the current question', () => {
  const messages = buildAnswerMessages('What tasks was it tested on?', 'context', [
    { role: 'user', content: 'What is AQ-BERT?' },
    { role: 'assistant', content: 'AQ-BERT is a quantization method.' },
  ])

  assert.deepEqual(
    messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'user']
  )
  assert.equal(messages[1]?.content, 'What is AQ-BERT?')
  assert.equal(messages[2]?.content, 'AQ-BERT is a quantization method.')
  assert.match(messages[3]?.content ?? '', /What tasks was it tested on\?/)
})

test('buildCitationRetryMessages asks for one grounded citation correction', () => {
  const originalMessages = buildAnswerMessages('What is AQ-BERT?', 'context')
  const retryMessages = buildCitationRetryMessages(
    originalMessages,
    'AQ-BERT is a quantization method.',
    ['S1', 'S2']
  )

  assert.equal(retryMessages.length, originalMessages.length + 2)
  assert.deepEqual(retryMessages.slice(0, originalMessages.length), originalMessages)
  assert.equal(retryMessages.at(-2)?.role, 'assistant')
  assert.equal(
    retryMessages.at(-2)?.content,
    'AQ-BERT is a quantization method.'
  )
  assert.equal(retryMessages.at(-1)?.role, 'user')
  assert.match(retryMessages.at(-1)?.content ?? '', /\[S1\], \[S2\]/)
  assert.match(retryMessages.at(-1)?.content ?? '', /do not add new facts/i)
})
