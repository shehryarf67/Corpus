import { randomUUID } from 'node:crypto'
import { createSessionToken, hashSessionToken } from '../src/lib/auth.js'
import { Sessions, Users } from '../src/lib/db.js'
import { SESSION_COOKIE } from '../src/middleware/auth.js'

export async function createTestUser(label: string) {
  const user = await Users.create(
    `${label}-${randomUUID()}@corpus.test`,
    'disabled:test-password-hash'
  )
  if (!user) throw new Error('Failed to create test user')
  return user
}

export async function createTestSessionCookie(userId: string): Promise<string> {
  const token = createSessionToken()
  await Sessions.create(
    userId,
    hashSessionToken(token),
    new Date(Date.now() + 60 * 60 * 1000)
  )
  return `${SESSION_COOKIE}=${token}`
}
