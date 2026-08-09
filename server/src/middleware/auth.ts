import type { Context } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { hashSessionToken } from '../lib/auth.js'
import {
  Sessions,
  type AuthenticatedSessionRow,
  type SessionRow,
  type UserRow,
} from '../lib/db.js'

export const SESSION_COOKIE = 'corpus_session'
export const SESSION_COOKIE_SECURE = process.env.NODE_ENV === 'production'

// This environment type tells Hono which values requireAuth places in the
// request context. Protected handlers can later use c.get('user') safely.
export type AuthEnv = {
  Variables: {
    user: UserRow
    session: SessionRow
  }
}

export function clearSessionCookie(c: Context): void {
  // Cookie deletion must match the path used when the cookie was created.
  deleteCookie(c, SESSION_COOKIE, {
    path: '/',
    secure: SESSION_COOKIE_SECURE,
    sameSite: 'Lax',
  })
}

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  // HttpOnly stops frontend JavaScript reading this value, but the browser
  // still includes it automatically with an authenticated request.
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  let authenticated: AuthenticatedSessionRow | null

  try {
    // The raw browser token is never stored. Hash it into the same form used
    // by the sessions table, then fetch the active session and user together.
    authenticated = await Sessions.getWithUserByTokenHash(
      hashSessionToken(token)
    )
  } catch (error) {
    console.error('authentication middleware failed', error)
    return c.json({ error: 'Authentication check failed' }, 500)
  }

  if (!authenticated) {
    // This covers unknown, revoked, and expired sessions. Clear the stale
    // browser cookie so later requests do not keep sending it.
    clearSessionCookie(c)
    return c.json({ error: 'Not authenticated' }, 401)
  }

  // Context values live only for this request. Calling next() continues to
  // the protected route after authentication has succeeded. It stays outside
  // the lookup catch so errors from the route keep their real meaning.
  c.set('user', authenticated.user)
  c.set('session', authenticated.session)
  await next()
})
