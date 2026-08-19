# Corpus product audit

Date: 2026-08-18
Scope: every user workflow from signup to document deletion.
Method: full read of `web/src`, live walkthrough in a browser against the real
stack (Next :3000, Hono :3001, Postgres 16.14, Ollama llama3.2, ingestion
worker), plus API-level probes where the UI was blocked.

Environment note: `tsc --noEmit` clean, `eslint` clean, 13/13 unit tests pass.

---

## Headline

The library and auth workflows are in good shape. **The workspace does not
work at all** - `/documents/[id]` never finishes loading, so the PDF pane,
pager, citation highlighting and streaming chat cannot be reached through the
UI. Everything downstream of that screen was verified at the API level instead,
and the retrieval/citation contract is sound, so this looks like one client-side
defect standing in front of a working feature rather than a broken feature.

Document deletion works on the backend but has no UI, so that workflow cannot be
completed by a user.

---

## Must fix

### M1. The workspace never becomes usable (blocking)

Reproduced twice on a freshly restarted dev server, including after a hard
reload. Opening `/documents/<id>` shows the library skeleton and the text
"Loading documents..." indefinitely.

What is actually happening:

- The server renders the page correctly - `curl` returns HTTP 200 in 378ms and
  the HTML contains both panes ("Preparing PDF viewer", "Ask a question about
  this document").
- In the browser, both `<section aria-label="Document">` and
  `<section aria-label="Conversation">` exist in the DOM but sit inside React's
  streaming holder: an ancestor `<div hidden>` with `display: none`, and
  `offsetParent === null`. The Suspense boundary never resolves on the client.
- `web_src_components_pdf-viewer_tsx_*.js` is requested **5 times** in a single
  page load - the signature of a lazy module that throws during evaluation and
  gets retried.
- Nothing is logged. No browser console error, and
  `web/.next/dev/logs/next-development.log` is clean. That is why it presents as
  an infinite spinner rather than an error.

Lead hypothesis (evidence-backed, not yet proven):
[pdf-document.tsx](../web/src/components/pdf-document.tsx) sets the worker at
module scope with a **bare package specifier** inside `new URL`:

```ts
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();
```

Turbopack cannot turn a bare specifier into an emitted asset, and
`next.config.ts` sets `turbopack.root` to the monorepo root, so resolution looks
outside `web/node_modules`. Probes for every plausible emitted worker path
returned 404.

Confirming step: log the resolved `workerSrc`, then copy the worker into
`web/public/` and set `workerSrc = "/pdf.worker.min.mjs"`. Re-test, then
re-audit the whole workspace - **M9, L1 and L2 below are currently unobservable
through the UI and need a second pass once this is fixed.**

### M2. Document deletion has no UI

`DELETE /documents/:documentId` works correctly - verified 200, then 404 on
re-read, the stored PDF removed from disk, cascade clean. But nothing in
`web/src` calls it: no `deleteDocument` in [api.ts](../web/src/lib/api.ts), no
button, no confirmation dialog. The workflow is unreachable from the product.

### M3. A failed login wipes both fields

React 19 resets uncontrolled form fields after a Server Action completes.
Verified live: after one failed sign-in, both `#email.value` and
`#password.value` are `""`. Mistype your password and you retype your email
address too, on the app's first screen.

### M4. Stale auth error survives the mode toggle

Fail a sign-in, then click "Create an account": the form switches to
"Create account" but still displays **"Invalid email or password"** underneath.
`useActionState` keeps its state when the action function swaps. Verified live.

### M5. An expired session shows a generic error instead of re-login

[documents/layout.tsx](../web/src/app/documents/layout.tsx) calls
`requireUser()`, but a layout does not re-render on client-side navigation - the
bundled Next auth guide says so explicitly. A cookie that is present but invalid
passes `proxy.ts`, then `getDocuments()` throws `ApiError(401)` and
`documents/error.tsx` renders "Something went wrong." There is no path back to
sign-in. Catch 401 in the page/DAL and redirect.

### M6. No root error boundary

Only `app/documents/error.tsx` exists. Both `/` and `/login` call
`getCurrentUser()`; if Hono is unreachable that throws a non-401 and the user
gets Next's raw error screen. Add `app/error.tsx` (and `global-error.tsx`).

### M7. The workspace shows the library's loading skeleton

`app/documents/loading.tsx` covers the whole segment, so opening a document
briefly renders "Library / Documents / Loading documents..." plus six fake card
placeholders. Add `app/documents/[id]/loading.tsx`.

### M8. The avatar is hardcoded "SH" for every user

[account-menu.tsx](../web/src/components/account-menu.tsx) hardcodes the
initials. Verified: signed in as `audit-ui@corpus.dev`, the avatar read "SH".
The menu also never shows which account you are in - the user's email appears
nowhere in the UI. `AuthUser` carries `email`, and there is no `name` field to
derive initials from.

### M9. The workspace claims "ready" for documents that are not

[\[id\]/page.tsx](../web/src/app/documents/[id]/page.tsx) hardcodes
`ready · {pageCount} pages` in the top bar, and `loadDocument` never checks
status. Reaching a still-processing document by URL reads "ready · 0 pages".
The library correctly refuses to link non-ready cards, but URL access is
ungated.

### M10. Chat errors are red; every other error is amber

[document-chat.tsx](../web/src/components/document-chat.tsx) uses
`text-red-400`, a raw Tailwind colour outside the design tokens. Auth and upload
errors use `text-marker`. A visible design-system break.

---

## Nice to have

### N1. Query latency is 47-78 seconds

Measured on a 7-page, 30-chunk document: 77.6s, 46.9s, 47.6s. The chat does show
staged progress ("Finding relevant passages...", "Writing the answer...") which
helps, but at this duration a demo reads as broken.

### N2. Broad questions return zero sources

"What is this document about?" produced a well-grounded answer with
`sources: []`. Specific questions returned real citations (`S1` page 6 with 387
chars of `highlightText`; `S3` page 6 with 127 chars). For a product whose
promise is "Keep the receipts", an answer with no receipts - and no explanation
of why - undercuts the core claim. The Sources block simply disappears.

### N3. Source labels are not reindexed

A single returned source can be labelled `S3` with no `S1` or `S2` present.
Separately, the login illustration shows `c07`, a third label format the product
never emits.

### N4. "Start over" does not delete the conversation

It clears local state and `conversationId`, but the row persists and a reload
restores the old thread via `getDocumentConversation`. Either delete server-side
or rename it "New chat".

### N5. Terminology drift: index vs process

"Upload and index" on the button; "preparing document...", "couldn't be
processed", "processing continues in the background" on the cards. Pick one
verb. Also the chat placeholder says "Ask about this paper..." while the empty
state says "this document" - "paper" is wrong for general PDFs.

### N6. Account menu accessibility

The `<details>` menu does not close on Escape, does not close on outside click,
and has no `aria-haspopup` or `aria-expanded`. All verified live.

### N7. The streaming answer is announced token-by-token

The message log is `aria-live="polite"` with `aria-relevant="additions text"`,
so a screen reader re-announces on every token. Announce on completion instead.

### N8. `chunkCount` is fetched and never shown

Present in `DocumentResponse`, unused in the UI. The earlier design showed
"indexed · N chunks · N pages".

### N9. The library lost its activity signal

`activityLine()` returns only "added Xh ago", and its own comment notes question
activity "is not in the real contract yet" - while the comment directly above
calls activity "the signal that tells a library apart from a plain file
listing". The backend has `conversations` and `messages`; the data exists.

### N10. Eight unused font preloads per page

All three families are preloaded across weights and styles; the console logs
eight "preloaded but not used" warnings on every page. Set `preload: false` on
the families that are not above the fold.

### N11. Upload dialog state survives close and reopen

`selectedFile` is not reset on close, so reopening shows the previous filename
with Upload enabled. Currently masked in the header by `key={documents.length}`
forcing a remount - itself a fragile hack, and the empty-state instance has no
such key.

### N12. Zoom has no fit-width and does not persist

Range 0.75-2.0, resets on reload.

### N13. The job poller has no backoff

Fixed 2s for up to 10 minutes: up to 300 Server Action round trips per job.

### N14. Inconsistent dismiss glyph

The status toast uses a lowercase `x`; the upload dialog uses `×`.

### N15. Inconsistent code style

`pdf-viewer.tsx` and `app/api/documents/[id]/pdf/route.ts` use 4-space indent,
and the route omits semicolons; everything else is 2-space with semicolons.
`api.ts` and `api-error.ts` carry learning-notes comments ("unknown makes us
prove what type the response is instead of allowing any insane stuff"). There is
no Prettier config.

### N16. `PdfViewer(PdfViewerProps: PdfViewerProps)`

The parameter is named after its own type and destructured inside; every other
component destructures in the signature.

---

## Later

- **L1. Every PDF page renders at once.** `pdf-document.tsx` mounts a `<Page>`
  per page. Ingestion accepts 20MB PDFs, so a few hundred pages means a few
  hundred canvases. Needs virtualization or a render window.
- **L2. Manual scroll does not update the pager.** The comments promise an
  IntersectionObserver that was never built. Scroll to page 5, the pager still
  reads 1, and Next then jumps to page 2.
- **L3. Dead code.** `pdf-page.tsx` and `pdf-page-client.tsx` are unused and
  duplicate the `workerSrc` setup implicated in M1.
- **L4. No mobile pane switch.** Panes stack below `lg`; the prototype had a
  switcher.
- **L5. No suggested questions.** Present in the prototype, not implemented.
- **L6.** `cookieStore.toString()` forwards every cookie to Hono, not just the
  session.
- **L7.** `copySessionCookie` uses `headers.get("set-cookie")`; it should use
  `getSetCookie()`. `.get()` comma-joins multiple Set-Cookie headers and
  `Expires` values contain commas, so this breaks as soon as a second cookie is
  set.
- **L8. Stale secrets in `server/.env`:** `ANTHROPIC_API_KEY` and
  `VOYAGE_API_KEY` are unreferenced (only comments mention Voyage). Gitignored,
  so not leaked, but dead config.
- **L9.** `server/data/uploads/` holds 10 orphaned PDFs (~28MB, including one
  19.8MB file) from earlier testing, with no delete UI to clear them (M2).
- **L10. No end-to-end test.** `web` has `test:unit` (13 passing) but no `test`
  script and no Playwright smoke, inconsistent with `server`'s `npm test`.
- **L11.** Workspace `metadata` is the static "Workspace · Corpus"; use
  `generateMetadata` with the document title.
- **L12.** The chat input is a single-line `<input>`; long questions scroll
  horizontally and there is no Shift+Enter multiline.

---

## What works well

Worth recording, because it is most of the app:

- **Upload is genuinely smooth.** Signup to library, then upload through the
  dialog, optimistic card, poller, and the card flipping itself to
  "ready · 7 pages" with no manual reload.
- **Upload validation is correct on all three layers.** A `.txt` file produced
  "Choose a PDF file. Other file types are not supported.", disabled the submit
  and cleared the input; the Server Action and Hono both re-validate.
- **Security holds up.** Logout revokes the session server-side (401 on reuse,
  not just a cleared cookie). Cross-tenant access returns 404 - not 403 - on
  `/documents/:id`, `/documents/:id/pdf` and `/query`. The cookie is HttpOnly,
  SameSite=Lax, with no `Secure` on localhost.
- **Delete is clean** on the backend: cascade plus file removal.
- **The pdfjs version trap was handled.** `web` pins `pdfjs-dist@5.4.296` to
  match react-pdf 10.4.1 while the server keeps 6.2.108.
- **The citation contract is real.** `highlightText` comes back with usable
  passages and page numbers, and the matching logic is unit-tested.
- **Empty state, 404 and error pages are designed**, not framework defaults.
- **No horizontal overflow at 375px** on the library.

---

## Acceptance criteria

Ship when all of these pass.

**Workspace**
1. `/documents/<ready-id>` renders the PDF with a visible first page, and no
   console errors.
2. The pager reflects manual scrolling, and Previous/Next move one page from
   wherever you actually are.
3. Clicking a source chip scrolls to the cited page and highlights the passage;
   when no confident match exists it still navigates to the page and does not
   throw.
4. A question streams token by token, then settles on the validated answer.
5. Opening a still-processing document by URL does not claim "ready".
6. A 100+ page PDF opens without freezing the tab.

**Auth**
7. A failed sign-in preserves the email and keeps the password error in context.
8. Toggling sign-in/sign-up clears any error from the other mode.
9. An expired or revoked session sends the user to `/login`, not to an error
   page.
10. With Hono stopped, `/` and `/login` show a designed error, not a stack
    trace.
11. The avatar shows the signed-in user's own initials, and the menu shows their
    email.
12. The account menu closes on Escape and on outside click.

**Library and lifecycle**
13. Upload, watch a card reach ready, and open it - without a manual reload.
14. Delete a document from the UI behind a confirmation; it disappears, and its
    PDF leaves `server/data/uploads/`.
15. A failed document shows its reason and Retry queues a fresh job.
16. Opening a document shows a workspace skeleton, never the library skeleton.

**Quality gates**
17. `npx tsc --noEmit`, `npm run lint`, and `npm run build` all clean in `web/`.
18. `npm test -w server` and `npm run test:db -w server` pass.
19. One Playwright smoke covers sign in, upload, ask, citation highlight.
20. No raw Tailwind colours outside the token set; one verb for
    indexing/processing across all copy.
21. No console warnings on a normal page load, including font preloads.

**Honesty**
22. Every claim in `README.md` is either true or removed - RLS, the eval table,
    and small-to-big retrieval in particular.

---

## Re-audit needed

M1 hid part of the product from this pass. Once the workspace loads, re-verify:
citation highlight accuracy on a chunk from the oversized-block splitter (whose
offsets `docs/ingestion-log.md` records as approximate), pager sync, streaming in
the real UI, and large-PDF behaviour.
