import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Hono } from 'hono'
import { Conversations, Documents, Messages, pool } from '../src/lib/db.js'
import { documentsRoute } from '../src/routes/documents.js'
import {
  createTestSessionCookie,
  createTestUser,
} from './auth-fixture.js'

after(async () => {
  await pool.end()
})

test('conversation history restores the newest owned chat and its sources', async () => {
  const owner = await createTestUser('conversation-history-owner')
  const stranger = await createTestUser('conversation-history-stranger')
  const ownerCookie = await createTestSessionCookie(owner.id)
  const ownedDocument = await Documents.create(
    owner.id,
    'Conversation history document',
    'history.pdf',
    'application/pdf'
  )
  const emptyDocument = await Documents.create(
    owner.id,
    'No conversation document',
    'empty-history.pdf',
    'application/pdf'
  )
  const foreignDocument = await Documents.create(
    stranger.id,
    'Foreign conversation document',
    'foreign-history.pdf',
    'application/pdf'
  )
  assert.ok(ownedDocument)
  assert.ok(emptyDocument)
  assert.ok(foreignDocument)

  const olderConversation = await Conversations.create(ownedDocument.id)
  const latestConversation = await Conversations.create(ownedDocument.id)
  assert.ok(olderConversation)
  assert.ok(latestConversation)

  await pool.query(
    `UPDATE conversations
     SET created_at = CASE
       WHEN id = $1 THEN NOW() - INTERVAL '1 hour'
       WHEN id = $2 THEN NOW()
     END
     WHERE id = ANY($3::uuid[])`,
    [
      olderConversation.id,
      latestConversation.id,
      [olderConversation.id, latestConversation.id],
    ]
  )

  await Messages.create(
    olderConversation.id,
    'user',
    'This older conversation should not be returned.'
  )
  await Messages.create(latestConversation.id, 'user', 'What is the result?')
  await Messages.create(
    latestConversation.id,
    'assistant',
    'The result is supported by the document [S1].',
    [
      {
        label: 'S1',
        chunkId: 'chunk-1',
        documentId: ownedDocument.id,
        pageNumber: 3,
        content: 'The supporting passage from page three.',
        similarity: 0.91,
      },
    ]
  )

  const app = new Hono()
  app.route('/documents', documentsRoute)

  try {
    const response = await app.request(
      `/documents/${ownedDocument.id}/conversation`,
      { headers: { Cookie: ownerCookie } }
    )
    assert.equal(response.status, 200)

    const body = await response.json()
    assert.equal(body.conversation.id, latestConversation.id)
    assert.equal(body.conversation.documentId, ownedDocument.id)
    assert.deepEqual(
      body.messages.map((message: { role: string }) => message.role),
      ['user', 'assistant']
    )
    assert.equal(body.messages[1].sources[0].chunkId, 'chunk-1')
    assert.equal(body.messages[1].sources[0].pageNumber, 3)

    const emptyResponse = await app.request(
      `/documents/${emptyDocument.id}/conversation`,
      { headers: { Cookie: ownerCookie } }
    )
    assert.equal(emptyResponse.status, 200)
    assert.deepEqual(await emptyResponse.json(), {
      conversation: null,
      messages: [],
    })

    const foreignResponse = await app.request(
      `/documents/${foreignDocument.id}/conversation`,
      { headers: { Cookie: ownerCookie } }
    )
    assert.equal(foreignResponse.status, 404)
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
      [owner.id, stranger.id],
    ])
  }
})
