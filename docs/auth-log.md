# Corpus auth log

This file logs the auth phase from the database foundation up to the frontend DAL.
It includes what we built, why we built it, the flow, and the mistakes or confusing parts we ran into.

## 1. What auth means in this project

We separated auth into three ideas:

1. Authentication: prove who the user is.
2. Session management: remember that the user is logged in across requests.
3. Authorization: decide whether that user can access a specific document, job, conversation, or query.

The backend is always the real security boundary. Frontend checks improve navigation and stop protected UI from rendering, but they are not enough to protect data by themselves.

## 2. Database foundation

We added migration 007_users_sessions.sql.

The users table stores:

- id
- email
- password_hash
- created_at

We never store the raw password. The auth layer hashes it first, then Users.create() only saves the finished hash.

The sessions table stores:

- id
- user_id
- token_hash
- expires_at
- created_at

The browser gets the raw random session token, but Postgres only stores its SHA-256 hash. This is similar to storing a password hash instead of the password itself. If the database leaks, the stored token hash is not the live cookie value.

We also added a case-insensitive unique email index. This means Test@example.com and test@example.com cannot become separate accounts.

Migration 008_document_ownership.sql added user_id to documents. This is what lets the backend scope documents to their owner.

Important roadblock:

The SQL migration file existing in the repo does not mean it has already changed the running database. Signup failed because the running Postgres database had no users or sessions tables yet. The backend tried INSERT INTO users, Postgres rejected it, and the route returned Signup failed.

The fix was to run:

```text
npm run migrate -w server
```

## 3. Database repositories

In server/src/lib/db.ts we created Users and Sessions repositories.

Users contains:

- create(email, passwordHash)
- getById(id)
- getByEmail(email)

Users.getByEmail() uses LOWER(email) = LOWER($1), so login email matching is case-insensitive.

Sessions contains:

- create(userId, tokenHash, expiresAt)
- getByTokenHash(tokenHash)
- getWithUserByTokenHash(tokenHash)
- deleteByTokenHash(tokenHash)
- deleteExpired()
- deleteAllForUser(userId)

Session lookups require expires_at > NOW(). An expired row may still physically exist until cleanup runs, but it can never authenticate a request.

getWithUserByTokenHash() joins sessions and users in one database request. We explicitly aliased columns so session.id and user.id do not overwrite or confuse each other. It returns this clear shape:

```text
{
  session: { ... },
  user: { ... }
}
```

## 4. Passwords and session tokens

server/src/lib/auth.ts handles cryptographic work.

Passwords use scrypt with a random salt. The saved password hash includes the algorithm version and settings so old passwords can still be checked if we increase the cost later.

Login uses timingSafeEqual() instead of a normal equality check for the final hash comparison.

Session tokens are different from passwords. They are already long random values, so SHA-256 is appropriate for hashing them before database storage.

The raw session token is never based on the user ID, email, password, or current time.

## 5. Backend auth routes

Auth routes is the correct phrase. We added these endpoints:

```text
POST /auth/signup
POST /auth/login
POST /auth/logout
GET  /auth/me
```

### Signup

Signup flow:

```text
email and password
-> validate input
-> normalize email
-> hash password
-> create user row
-> create session row
-> set session cookie
-> return public user data
```

The HTTP response never includes password_hash.

### Login

Login flow:

```text
email and password
-> find user by email
-> verify entered password
-> create session row
-> set session cookie
-> return public user data
```

Unknown email and wrong password return the same Invalid email or password response. We also verify a dummy hash when the email does not exist. This avoids making unknown users noticeably faster and leaking which emails are registered through timing.

### Logout

Logout flow:

```text
read raw cookie token
-> hash token
-> delete matching database session
-> clear browser cookie
```

Logout is safe if the cookie or session row does not exist. Deleting the database session is important because clearing only the browser cookie would leave the token valid if someone had copied it.

### Me

GET /auth/me answers one question:

```text
Which valid user does this cookie belong to?
```

It reads the cookie, hashes the token, joins the active session with its user, and returns safe public user data. Missing, revoked, and expired sessions return 401.

## 6. What the cookie does

The cookie is the browser's temporary login pass. It does not contain the password.

The main flow is:

```text
browser has raw session token in cookie
-> request sends cookie
-> backend hashes token
-> backend finds matching active session
-> session row provides trusted user_id
-> backend knows which user made the request
```

Cookie settings:

- HttpOnly means browser JavaScript cannot read the token.
- SameSite=Lax helps reduce cross-site request attacks.
- Secure is enabled in production so the cookie only travels over HTTPS.
- expires and Max-Age give the browser the same session lifetime used by the database.
- path=/ makes the cookie available across the app.

The frontend never sends a user ID and asks the backend to trust it. A user could edit that value. The frontend sends the cookie, and the backend discovers the trusted user ID from the matching database session.

## 7. Authentication middleware

We added requireAuth in server/src/middleware/auth.ts.

Its flow is:

```text
incoming request
-> read corpus_session cookie
-> hash raw token
-> find active session and user
-> attach user and session to Hono request context
-> continue to route
```

If the session is missing or expired, it returns 401 and clears the stale cookie.

We mounted requireAuth inside each protected router:

- /documents
- /jobs
- /query

After middleware succeeds, route code can use c.get('user').id. That ID came from the verified database session, not from request JSON.

## 8. Ownership enforcement

Authentication only tells us who the user is. Authorization checks whether that user owns the requested resource.

Example document lookup:

```text
document ID from URL
+ trusted user ID from requireAuth
-> SELECT document WHERE id = documentId AND user_id = userId
```

We scoped document listing, document lookup, document deletion, job lookup, normal queries, streaming queries, and conversations.

Foreign resources return 404 instead of 403. This prevents the API from confirming that another user's document or job exists.

For deletion we use one statement:

```text
DELETE FROM documents
WHERE id = documentId AND user_id = userId
RETURNING *
```

This performs ownership checking and deletion together. It avoids the race window created by SELECT, check, then DELETE.

prepareQuery() also receives the trusted user ID from the protected query route. Its first database lookup verifies document ownership before retrieval, rewriting, generation, or conversation work continues.

## 9. Frontend auth wrappers

The Next.js frontend uses Server Actions for login, signup, and logout.

The login form does not call Hono directly from browser JavaScript. It submits to a Next Server Action, and that action calls the backend auth route.

There was one important cookie problem to solve:

```text
browser -> Next Server Action -> Hono backend
```

Hono's Set-Cookie response went back to the Next server, not directly to the browser. Without extra handling, login could succeed in the backend but the browser would still look logged out.

auth-api.ts fixes this by copying the backend Set-Cookie header into Next's response cookie store. The browser then receives and stores it.

For later server-side API requests, requestRaw() reads the browser cookies from Next and forwards them to Hono in the Cookie header.

Frontend flow after login:

```text
browser stores cookie
-> browser requests Next page
-> Next receives cookie
-> Next API helper forwards cookie to Hono
-> Hono verifies session
-> Hono returns trusted user or protected data
```

We also removed the temporary skip link, added loading and error states, and added a logout button.

## 10. Protected frontend pages

The /documents layout protects every page under /documents.

If the user is authenticated, the page renders. If not, the frontend redirects to /login.

The /login page performs the opposite convenience check. If a valid user is already logged in, it redirects to /documents instead of showing the login form again.

The root / route sends authenticated users to /documents and everyone else to /login.

These frontend checks are for UI and navigation. The backend still checks every protected API request independently.

## 11. The DAL

DAL means Data Access Layer.

We added web/src/lib/dal.ts as the frontend server's single place for answering:

```text
Who is currently logged in?
```

It contains:

- getCurrentUser()
- requireCurrentUser()

getCurrentUser() calls GET /auth/me and returns either the verified user or null. It uses React cache() so repeated checks during the same server render do not repeat the same backend request.

requireCurrentUser() calls getCurrentUser(). If no user exists, it redirects to /login. Protected server UI can call one helper instead of repeating the API call and redirect logic everywhere.

The exact DAL flow for /documents is:

```text
browser requests /documents with cookie
-> documents layout calls requireCurrentUser()
-> DAL calls GET /auth/me
-> Next forwards cookie to Hono
-> Hono finds active session
-> Hono gets trusted user from database
-> Hono returns public user
-> DAL returns user
-> documents page renders
```

If the session is invalid:

```text
Hono returns 401
-> DAL turns expected 401 into null
-> requireCurrentUser() redirects to /login
```

The biggest clarification we made was this:

The DAL does not send a user ID to the backend for verification. It sends or forwards the session cookie. The backend verifies the cookie and returns the trusted user. The DAL receives that user so frontend server code can make UI and navigation decisions.

The frontend may use returned user details for:

- deciding whether to render protected UI
- redirecting away from login
- showing the email or initials
- displaying account information later

The backend uses its independently verified user ID for real ownership and authorization checks.

## 12. Complete auth request flow

```text
LOGIN
browser form
-> Next Server Action
-> POST /auth/login
-> backend verifies password
-> backend creates session
-> backend returns Set-Cookie
-> Next copies Set-Cookie to browser response
-> browser stores cookie

PROTECTED REQUEST
browser sends cookie
-> Next page or API helper
-> cookie forwarded to Hono
-> requireAuth verifies active database session
-> trusted user attached to request context
-> ownership-scoped database operation runs
-> result returned

LOGOUT
browser logout form
-> Next Server Action
-> POST /auth/logout with cookie
-> backend deletes session row
-> backend clears cookie
-> Next copies cookie deletion to browser
-> browser removes cookie
-> redirect to /login
```

## 13. Other roadblocks

We hit a development port collision because an old Next dev process was still holding port 3000. Next tried port 3001, which then collided with the Hono backend. We stopped the stale process and confirmed the intended setup:

```text
Next frontend: http://localhost:3000
Hono backend:  http://localhost:3001
Postgres:      localhost:5432
```

The main lesson is that EADDRINUSE means another process already owns the requested port. It is not an auth code failure.

## 14. Final mental model

```text
Cookie proves the session
-> backend discovers the trusted user
-> middleware protects the route
-> scoped SQL protects the resource
-> DAL helps frontend server code understand the current user
```

Short version:

- Cookie: the browser's temporary login pass.
- Session table: connects a valid token hash to a user.
- requireAuth: verifies the cookie for backend routes.
- Ownership SQL: checks whether that verified user owns the resource.
- DAL: gives frontend server code one clean way to ask who is logged in.
- Backend: remains the final authority for all protected data and operations.
