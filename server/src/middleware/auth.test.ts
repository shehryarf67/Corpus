import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Hono } from 'hono'
import { hashSessionToken } from '../lib/auth.js'
import { pool } from '../lib/db.js'
import { documentsRoute } from '../routes/documents.js'
import { jobsRoute } from '../routes/jobs.js'
import { queryRoute } from '../routes/query.js'
import {
  requireAuth,
  SESSION_COOKIE,
  type AuthEnv,
} from './auth.js'

type MockQuery = (
  sql: string,
  values?: unknown[]
) => Promise<{ rows: unknown[] }>

// The middleware repository calls the shared pool. Replacing only query lets
// these focused tests verify auth flow without needing a live Postgres server.
const mutablePool = pool as unknown as { query: MockQuery }
const originalQuery = mutablePool.query

afterEach(() => {
  mutablePool.query = originalQuery
})

function protectedApp() {
  const app = new Hono<AuthEnv>()
  app.use(requireAuth)
  app.get('/private', (c) =>
    c.json({
      userId: c.get('user').id,
      sessionId: c.get('session').id,
    })
  )
  return app
}

test('requireAuth rejects a request without a session cookie', async () => {
  const response = await protectedApp().request('/private')

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Not authenticated' })
})

test('documents, jobs, and query routers are protected', async () => {
  const responses = await Promise.all([
    documentsRoute.request('/', { method: 'POST' }),
    jobsRoute.request('/job-1'),
    queryRoute.request('/', { method: 'POST' }),
  ])

  assert.deepEqual(
    responses.map((response) => response.status),
    [401, 401, 401]
  )
})

test('requireAuth attaches the active session and user to context', async () => {
  const rawToken = 'browser-session-token'

  mutablePool.query = async (_sql, values) => {
    assert.deepEqual(values, [hashSessionToken(rawToken)])
    return {
      rows: [
        {
          session_id: 'session-1',
          session_user_id: 'user-1',
          session_token_hash: hashSessionToken(rawToken),
          session_expires_at: '2099-01-01T00:00:00.000Z',
          session_created_at: '2026-01-01T00:00:00.000Z',
          user_id: 'user-1',
          user_email: 'user@example.com',
          user_password_hash: 'stored-hash',
          user_created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }
  }

  const response = await protectedApp().request('/private', {
    headers: { Cookie: `${SESSION_COOKIE}=${rawToken}` },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    userId: 'user-1',
    sessionId: 'session-1',
  })
})

test('requireAuth clears a cookie whose session is invalid or expired', async () => {
  mutablePool.query = async () => ({ rows: [] })

  const response = await protectedApp().request('/private', {
    headers: { Cookie: `${SESSION_COOKIE}=expired-token` },
  })

  assert.equal(response.status, 401)
  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/i)
})
