import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from '../lib/auth.js'
import { Sessions, Users, type UserRow } from '../lib/db.js'
import {
  clearSessionCookie,
  SESSION_COOKIE,
  SESSION_COOKIE_SECURE,
} from '../middleware/auth.js'

export const authRoute = new Hono()

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_DURATION_SECONDS = SESSION_DURATION_MS / 1000

type Credentials = {
  email: string
  password: string
}

// Start one valid dummy hash when the module loads. Unknown-email logins verify
// against it, so they do roughly the same expensive work as wrong passwords.
const dummyPasswordHash = hashPassword('not-a-real-user-password')

function publicUser(user: UserRow) {
  // Never include password_hash in an HTTP response.
  return {
    id: user.id,
    email: user.email,
    created_at: user.created_at,
  }
}

async function readCredentials(c: Context): Promise<Credentials | null> {
  try {
    const body: unknown = await c.req.json()
    if (!body || typeof body !== 'object') return null

    const { email, password } = body as Record<string, unknown>
    if (typeof email !== 'string' || typeof password !== 'string') return null

    // Email casing is not meaningful for this app. Passwords are deliberately
    // not trimmed because spaces may be part of a user's chosen password.
    const normalizedEmail = email.trim().toLowerCase()
    if (
      !normalizedEmail ||
      !normalizedEmail.includes('@') ||
      normalizedEmail.length > 320 ||
      password.length < 8 ||
      password.length > 1024
    ) {
      return null
    }

    return { email: normalizedEmail, password }
  } catch {
    // Invalid JSON is a bad request, not an internal server error.
    return null
  }
}

async function startSession(c: Context, userId: string): Promise<Date> {
  const token = createSessionToken()
  const tokenHash = hashSessionToken(token)
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS)

  // The database stores only the hash. The raw token exists in the browser's
  // HttpOnly cookie, so frontend JavaScript cannot read or steal it directly.
  await Sessions.create(userId, tokenHash, expiresAt)
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: SESSION_COOKIE_SECURE,
    path: '/',
    expires: expiresAt,
    maxAge: SESSION_DURATION_SECONDS,
  })

  return expiresAt
}

function isUniqueViolation(error: unknown): boolean {
  // PostgreSQL error 23505 is raised by the case-insensitive email index when
  // signup attempts to create an account that already exists.
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  )
}

authRoute.post('/signup', async (c) => {
  const credentials = await readCredentials(c)
  if (!credentials) {
    return c.json({ error: 'A valid email and password are required' }, 400)
  }

  try {
    // Password hashing belongs in the auth layer. Users.create only persists
    // the already-produced hash and does not know the raw password.
    const passwordHash = await hashPassword(credentials.password)
    const user = await Users.create(credentials.email, passwordHash)
    if (!user) throw new Error('User creation returned no row')

    const expiresAt = await startSession(c, user.id)
    return c.json(
      {
        user: publicUser(user),
        sessionExpiresAt: expiresAt.toISOString(),
      },
      201
    )
  } catch (error) {
    if (isUniqueViolation(error)) {
      return c.json({ error: 'An account with this email already exists' }, 409)
    }

    console.error('signup failed', error)
    return c.json({ error: 'Signup failed' }, 500)
  }
})

authRoute.post('/login', async (c) => {
  const credentials = await readCredentials(c)
  if (!credentials) {
    return c.json({ error: 'A valid email and password are required' }, 400)
  }

  try {
    const user = await Users.getByEmail(credentials.email)

    // Always verify one hash. This avoids a fast "unknown user" branch that
    // could reveal whether an email exists through response timing.
    const passwordHash = user?.password_hash ?? (await dummyPasswordHash)
    const passwordMatches = await verifyPassword(
      credentials.password,
      passwordHash
    )

    // Unknown user and wrong password deliberately share one response.
    if (!user || !passwordMatches) {
      return c.json({ error: 'Invalid email or password' }, 401)
    }

    const expiresAt = await startSession(c, user.id)
    return c.json({
      user: publicUser(user),
      sessionExpiresAt: expiresAt.toISOString(),
    })
  } catch (error) {
    console.error('login failed', error)
    return c.json({ error: 'Login failed' }, 500)
  }
})

authRoute.post('/logout', async (c) => {
  try {
    const token = getCookie(c, SESSION_COOKIE)

    // Logout is idempotent: a missing cookie or database row is still success.
    // When present, deleting the server row immediately revokes the session.
    if (token) {
      await Sessions.deleteByTokenHash(hashSessionToken(token))
    }

    clearSessionCookie(c)
    return c.json({ ok: true })
  } catch (error) {
    console.error('logout failed', error)
    return c.json({ error: 'Logout failed' }, 500)
  }
})

authRoute.get('/me', async (c) => {
  try {
    const token = getCookie(c, SESSION_COOKIE)
    if (!token) {
      return c.json({ error: 'Not authenticated' }, 401)
    }

    // One JOIN returns the active session and user together. The repository
    // excludes expired sessions before this route receives them.
    const authenticated = await Sessions.getWithUserByTokenHash(
      hashSessionToken(token)
    )

    if (!authenticated) {
      clearSessionCookie(c)
      return c.json({ error: 'Not authenticated' }, 401)
    }

    return c.json({ user: publicUser(authenticated.user) })
  } catch (error) {
    console.error('auth check failed', error)
    return c.json({ error: 'Authentication check failed' }, 500)
  }
})
