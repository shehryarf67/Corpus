import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Conversations, Documents, Messages, pool } from '../src/lib/db.js'

after(async () => {
  await pool.end()
})

test('a conversation stores its messages in chronological order', async () => {
  let documentId: string | undefined

  try {
    const document = await Documents.create(
      'Conversation integration test',
      'conversation-test.pdf',
      'application/pdf'
    )
    assert.ok(document)
    documentId = document.id

    const conversation = await Conversations.create(document.id)
    assert.ok(conversation)
    assert.equal(conversation.document_id, document.id)

    await Messages.create(conversation.id, 'user', 'What is AQ-BERT?')
    await Messages.create(conversation.id, 'assistant', 'It is a quantization method.')
    await Messages.create(conversation.id, 'user', 'What tasks was it tested on?')

    const history = await Messages.getByConversationId(conversation.id)

    assert.deepEqual(
      history.map((message) => message.role),
      ['user', 'assistant', 'user']
    )
    assert.deepEqual(
      history.map((message) => message.content),
      [
        'What is AQ-BERT?',
        'It is a quantization method.',
        'What tasks was it tested on?',
      ]
    )
  } finally {
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    }
  }
})

test('Messages.create rejects an empty message before querying Postgres', async () => {
  await assert.rejects(Messages.create('unused-conversation-id', 'user', '   '), {
    message: 'Message content cannot be empty',
  })
})

test('recent history keeps the newest messages but returns them oldest first', async () => {
  let documentId: string | undefined

  try {
    const document = await Documents.create(
      'Recent history test',
      'recent-history-test.pdf',
      'application/pdf'
    )
    assert.ok(document)
    documentId = document.id

    const conversation = await Conversations.create(document.id)
    assert.ok(conversation)

    await Messages.create(conversation.id, 'user', 'Message one')
    await Messages.create(conversation.id, 'assistant', 'Message two')
    await Messages.create(conversation.id, 'user', 'Message three')

    const recent = await Messages.getRecentByConversationId(conversation.id, 2)
    assert.deepEqual(
      recent.map((message) => message.content),
      ['Message two', 'Message three']
    )
  } finally {
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    }
  }
})

test('deleting a document also deletes its conversations and messages', async () => {
  const document = await Documents.create(
    'Conversation cascade test',
    'conversation-cascade-test.pdf',
    'application/pdf'
  )
  assert.ok(document)

  const conversation = await Conversations.create(document.id)
  assert.ok(conversation)
  await Messages.create(conversation.id, 'user', 'Temporary message')

  await pool.query('DELETE FROM documents WHERE id = $1', [document.id])

  assert.equal(await Conversations.getById(conversation.id), null)
  assert.deepEqual(await Messages.getByConversationId(conversation.id), [])
})
