import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Documents, Messages, pool } from '../src/lib/db.js'
import { embedChunks } from '../src/lib/pdf/embed.js'
import { persistEmbeddedChunks } from '../src/lib/pdf/persist.js'
import { prepareQuery } from '../src/services/query.js'
import { createTestUser } from './auth-fixture.js'

let testUserId: string

before(async () => {
  testUserId = (await createTestUser('prepare-query')).id
})

after(async () => {
  await pool.query('DELETE FROM users WHERE id = $1', [testUserId])
  await pool.end()
})

test('prepareQuery gets generation inputs ready without generating an answer', async () => {
  let documentId: string | undefined

  try {
    const document = await Documents.create(
      testUserId,
      'Prepare query integration test',
      'prepare-query-test.pdf',
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
      {
        chunkIndex: 1,
        content: 'Saturn is known for its large ring system.',
        page: 1,
        charStart: 46,
        charEnd: 88,
      },
    ])
    await persistEmbeddedChunks(document.id, embeddedChunks)

    const prepared = await prepareQuery(
      document.id,
      'Which planet is known as the Red Planet?',
      testUserId
    )

    assert.equal(prepared.sources[0]?.content, embeddedChunks[0]?.content)
    assert.equal(prepared.messages[0]?.role, 'system')
    assert.match(
      prepared.messages.at(-1)?.content ?? '',
      /Which planet is known as the Red Planet\?/
    )

    // Preparation saves the user's question, but final generation is the step
    // responsible for creating the one assistant message afterward.
    const storedMessages = await Messages.getByConversationId(
      prepared.conversationId
    )
    assert.deepEqual(
      storedMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      [
        {
          role: 'user',
          content: 'Which planet is known as the Red Planet?',
        },
      ]
    )
  } finally {
    if (documentId) {
      await pool.query('DELETE FROM documents WHERE id = $1', [documentId])
    }
  }
})
