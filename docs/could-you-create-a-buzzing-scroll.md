# Corpus — Frontend Implementation Plan

## Context

The backend is done. The frontend has never called it once — no `fetch()`, no env
var, no route handler anywhere in `web/`. Every screen renders from
`web/src/lib/mock-documents.ts`, and `/documents/[id]` shows the same hardcoded
paper regardless of `id`.

This plan wires the frontend to the real API, builds the two features the README
advertises but nothing implements (citation → highlighted passage in the PDF, and
token streaming), and adds the auth + multi-tenancy the schema has no trace of.

**Work one phase per session.** Each phase leaves the app runnable.

## Decisions

| | |
|---|---|
| PDF | react-pdf (real PDF, needed for citation→source) |
| Backend gaps | In scope — can't drop mocks without them |
| Auth | Real: users, sessions, ownership |
| Order | Auth first, because `GET /documents` 401s without a session |
| Tests | Vitest for the 2 fiddly pure functions + 1 Playwright smoke |
| Thumbnails | Deferred (Phase 5) |

---

## ⚠️ Traps (each one verified, not assumed)

1. **react-pdf pins `pdfjs-dist` to exactly `5.4.296`**; root has `^6.2.108` for the
   server. Resolve the worker from the wrong copy → `API version does not match
   Worker version`. Pin `web`'s own `pdfjs-dist@5.4.296`.
2. **`middleware.ts` → `proxy.ts`** in v16. Cookie-presence check only, no DB — it
   runs on prefetches. Real check goes in a `cache()`-memoized DAL per page, not
   in a layout (layouts don't re-render on navigation).
3. **`dynamic(..., {ssr:false})` only works in a Client Component** — errors in a
   server component, so the PDF viewer needs a `'use client'` wrapper.
4. **Node `fetch` has no cookie jar.** `web/src/lib/api.ts` must set the `Cookie`
   header explicitly, in one place. Forget it → everything 401s.
5. **`Secure` on a localhost cookie is silently dropped.** Gate on `NODE_ENV`.
6. **Server Action bodies cap at 1MB**, but PDFs are allowed up to 20MB → upload
   needs `serverActions.bodySizeLimit`.
7. **`app.use('/documents/*', requireAuth)` does not match `/documents`** — so the
   list route would be unauthenticated. Put `router.use('*', requireAuth)` inside
   each sub-router instead.
8. **Return 404, not 403**, for another user's resource (403 confirms it exists).
9. **`prepareQuery` creates a `conversations` row before validating anything** —
   the ownership check must run first, in the route.
10. **Streamed `token` text ≠ `done.answer`** (the latter is citation-normalized).
    Replace the accumulated text at the end, don't append.
11. **`EventSource` can't POST** → `fetch` + `ReadableStream` + manual SSE parsing.
    And the proxying route handler must pass `upstream.body` through — any
    `await upstream.text()` collapses the stream and kills the feature.
12. **`chunk.char_start/char_end` cannot drive highlighting.** They're offsets into
    `layout.ts`'s *reconstructed* per-page text, reset per page, and
    `docs/ingestion-log.md` records them as approximate for oversized-block
    splits. Highlighting must find `chunk.content` in the rendered text layer by
    normalized text matching. **Biggest risk in the plan.**
13. **Page count is never persisted** — `extract.ts` reads `numPages` and discards
    it; nothing writes `documents.metadata`. The UI's "4 pages" has no source.
14. **`uploadedAt` shape mismatch:** `activityLine()` interpolates the mock's bare
    `"2026-08-02"` raw; the API returns ISO, which would render as
    `added 2026-08-02T14:03:11.412Z`. Route it through `formatRelativeTime`.
15. **RLS in the README is false.** The app connects as the `postgres` superuser,
    and RLS is unconditionally bypassed for superusers — policies written today
    would be a decorative no-op. See Phase 1.
16. **No job lease/retry:** a worker crash leaves a job stuck `parsing` forever, so
    an "indexing" card spins indefinitely. Needs a timeout or a reaper.

---

## Phase 0 — API layer

Architecture: **Next as a backend-for-frontend.** Server Components and Server
Actions call Hono directly; the browser only ever talks to `:3000`. Kills the
cross-origin cookie problem (trap #5) and hides the API.

- [ ] `web/.env.local`: `API_BASE_URL=http://localhost:3001` — deliberately **not**
      `NEXT_PUBLIC_*`, so the internal host never enters the client bundle. Commit
      a `.env.example`.
- [ ] `web/src/lib/api.ts` — one low-level `request<T>()` that attaches the Cookie
      header (trap #4) and sets `cache: 'no-store'`, plus one typed function per
      endpoint. Types live here as the single source of truth; re-export
      `DocumentStatus` with the mock's exact `'ready'|'indexing'|'failed'` union so
      components don't change when the mocks die. Server-only by construction —
      it imports `next/headers`, which is a build error from a client component.
- [ ] `web/src/lib/dal.ts` — `requireUser = cache(...)` → `redirect('/login')` on
      401. Note: it runs during render, so it **cannot** clear a stale cookie
      (`cookies().delete()` is illegal there) — only redirect.
- [ ] Add the missing `loading.tsx` / `error.tsx` / `not-found.tsx`.

## Phase 1 — Auth + multi-tenancy

Land the migration and the enforcement together; they're one breaking beat.

- [ ] `007_users_sessions.sql` — `users` (unique index on `lower(email)`, no citext),
      `sessions` (`token_hash`, `expires_at`).
- [ ] `008_document_ownership.sql` — `documents.user_id NOT NULL REFERENCES users`,
      with a backfill user for the one existing row. `migrate.ts` runs each file in
      a transaction, so it's atomic. **Don't** add `user_id` to
      chunks/conversations/messages — derive through `documents` via the existing
      FKs, which also gives cascade delete for free.
- [ ] `server/src/lib/auth.ts` — `crypto.scrypt` (promisified, **not** `scryptSync`
      — it blocks the loop ~100ms per login), self-describing hash record,
      `timingSafeEqual`. Session token = `randomBytes(32).base64url`; store only
      `sha256(token)`, so a DB dump doesn't hand out live sessions. Unit-test the
      hashing half — no DB needed.
- [ ] `Users`/`Sessions` helpers in `db.ts`, replacing the `User = {}` stub.
- [ ] `server/src/routes/auth.ts` — signup / login / logout / me. Login must return
      an identical error **and comparable latency** for unknown-email vs wrong-
      password (run a dummy verify on the unknown branch) or it's an enumeration
      oracle.
- [ ] `requireAuth` middleware, mounted per sub-router (trap #7). Ownership as a
      single statement where possible (`DELETE ... WHERE id=$1 AND user_id=$2
      RETURNING *`) rather than read-then-check-then-write.
- [ ] Scoped helpers take `userId` as the **first required arg** so TS refuses an
      unscoped call. Rename `Documents.getById` → `getByIdUnscoped` (one caller:
      `ingestion.ts`) so grepping `Unscoped` is the audit. Delete
      `Documents.getAll` — it returns every document to anyone.
- [ ] `assertDocumentAccess()` called at the top of both query handlers — in the
      **route**, not the service, since `eval/` and the e2e test call the services
      directly.
- [ ] **RLS verdict: don't build it.** Making it real needs a non-superuser role,
      per-request `SET LOCAL` on a *pinned* connection (a plain `SET` on a pooled
      client leaks across requests — worse than no RLS), a rewrite of `db.ts` to
      pass clients instead of `pool`, and a bypass for the worker, whose
      `claimNextPending()` deliberately scans all tenants. Enforce in predicates
      and **fix the README's three RLS claims** instead.
- [ ] Web: `login/actions.ts` Server Actions + `useActionState` in `auth-form.tsx`
      (keep inputs uncontrolled — `FormData` is the idiom). *Return* `{error}` for
      a bad password; throwing trips an error boundary. Keep `redirect()` **outside**
      any try/catch — it throws a control-flow exception a catch would swallow.
- [ ] `proxy.ts` optimistic check; `?next=` validated to start with `/` and not
      `//` (open redirect); `page.tsx` → `/documents` when a cookie is present.
- [ ] Avatar → `AccountMenu` behind `<Suspense>` so awaiting the session doesn't
      hold `{children}` in the shared `TopBar`. Sign-out must call the logout route
      so the session row is actually revoked, not just the cookie cleared.

## Phase 2 — Library on real data

- [ ] Persist page count in ingestion (trap #13); `COALESCE(MAX(page_number),0)` is
      the stopgap.
- [ ] `Documents.listForUser()` — **one** query with `LEFT JOIN LATERAL` for the
      latest job + chunk count + question count + last-asked. Not a per-document
      loop; that N+1 is exactly what a reviewer looks for.
- [ ] `GET /documents`, `GET /documents/:id` returning a `DocumentSummary` that
      mirrors `MockDocument` field-for-field, so the swap is mechanical. Never
      expose `storage_key`.
- [ ] Point both pages at the API, fix `uploadedAt` (trap #14), **delete
      `mock-documents.ts`** and the `?state=empty` param.

## Phase 3 — Upload + progress

- [ ] Upload Server Action + `bodySizeLimit` (trap #6); client guards mirroring the
      server's PDF/20MB checks.
- [ ] Optimistic `indexing` card → poll `GET /jobs/:jobId`; give up visibly rather
      than polling forever (trap #16).
- [ ] Wire the dashed empty-state panel as a real drop zone, and `Retry`.

## Phase 4 — Workspace: PDF + citations + streaming

Two route handlers — the only traffic the *browser* must issue itself:
`app/api/documents/[id]/pdf/route.ts` and `app/api/query/stream/route.ts`.

- [ ] `GET /documents/:id/file` on Hono, reusing `readPdf` from `storage.ts`.
      `documents.filename` is user-supplied and goes in `Content-Disposition` →
      sanitize ASCII + strip CR/LF/quotes or it's header injection. ENOENT → 404.
- [ ] react-pdf + pinned `pdfjs-dist` (trap #1), `'use client'` wrapper (trap #3),
      text-layer CSS imported (required for highlighting).
- [ ] **Passage location** — normalize both sides (collapse whitespace, fold
      ligatures, strip hyphenation), find `chunk.content` in the page's text layer,
      map back to spans. Fail soft: still scroll to the page, don't crash. Handle
      cross-page chunks and duplicate matches. **Unit-test in isolation** (trap #12).
      `ContextSource` carries `chunkId`/`pageNumber` but not offsets — widen it
      rather than adding a `GET /chunks/:id` route.
- [ ] Replace the hardcoded paper JSX and the literal `1 / 4` pager with real
      pages + working prev/next.
- [ ] SSE reader (trap #11); swap in `done.answer` at the end (trap #10); abort on
      unmount. Handle the two refusal strings distinctly from errors.
- [ ] `[S1]` markers → real focusable `<button>`s carrying the existing `.cite`
      class (they're non-focusable `<span>`s that only look clickable today).
      Clicking one drives the highlight. `aria-live` on the streaming answer.
- [ ] Real source chips from `sources`; thread `conversationId` through follow-ups;
      restore history via `GET /conversations/:id/messages`.
- [ ] Highlight animation reuses the prototype's language (`marker-soft` wash,
      `cubic-bezier(.22,1,.36,1)`, ~110ms stagger), gated on `prefers-reduced-motion`.
- [ ] **Retrieval trace:** the prototype shows `rewrite → search → fuse → rerank`
      but the stream only emits `generating|finalizing`. Either emit real stage
      events or show only the two honest ones — **don't fabricate timings.**

## Phase 5 — Polish

- [ ] Real page-1 thumbnails (rasterise at ingest; needs a canvas backend) →
      replaces `page-preview.tsx`.
- [ ] Mobile pane switch below 940px (panes just stack today).
- [ ] Delete with confirmation. Note: deleting a user cascades the DB but
      **orphans PDFs** in `server/data/uploads`.
- [ ] Re-run `npm run eval:query`, replace the README's placeholder table, and
      reconcile the remaining untrue claims (RLS, small-to-big retrieval).

---

## Testing

- [ ] Vitest + a `test` script in `web/` (neither exists).
- [ ] Unit-test the two genuinely fiddly pure functions: **passage matching** and
      **SSE frame parsing**. Both break silently and can't be eyeballed.
- [ ] One Playwright smoke: sign in → upload → indexed → ask → citation highlights.

## Verification

Four things must be up:
```bash
docker ps                        # pgvector container (Docker Desktop open)
curl -s http://localhost:11434   # Ollama
npm run dev                      # web :3000, server :3001
npm run worker -w server         # separate terminal — npm run dev does NOT start it
```

- **Phase 1:** signed out → `/documents` redirects to `/login`. Two accounts see
  disjoint libraries. `curl` another user's `documentId` on `/query` → **404**.
- **Phase 2:** `/documents` renders real rows; `grep -r mock-documents web/src`
  comes back empty.
- **Phase 3:** upload `docs/test_pdf.pdf`; card goes indexing → ready; worker logs
  `finished job … N chunks`.
- **Phase 4:** clicking a citation scrolls to and highlights the passage *in the
  PDF*. Deliberately test a chunk from the oversized-block splitter to exercise
  the fallback. Answers stream, then swap to `done.answer`.
- **Always:** `npx tsc --noEmit`, `npm run lint`, `npm run build` in `web/`.
- **After the Phase 1 migration**, the server's Postgres integration tests must
  still pass: `npm test -w server && npm run test:db -w server`.
