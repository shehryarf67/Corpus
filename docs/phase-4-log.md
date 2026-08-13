Phase 4: protected PDF access and document viewer
=================================================

Step 1: protected PDF backend endpoint
=======================================

We started GET /documents/:documentId/pdf inside the existing documents router. This is separate from GET /documents/:documentId:

```text
GET /documents/:documentId
-> returns lightweight JSON metadata about the document

GET /documents/:documentId/pdf
-> returns the actual stored PDF bytes
```

The route uses Documents.getByIdForUser(documentId, userId), so authentication comes from documentsRoute.use(requireAuth) and ownership is checked before storage is read. A missing document, foreign document, missing storage key, or ENOENT physical-file error returns the same 404. This avoids revealing whether another user's document exists. Other storage errors are rethrown because permission errors, corruption, and unexpected server failures are 500-level problems, not missing resources.

readPdf() is asynchronous and returns a Node Buffer, so we await it and convert it into Uint8Array before passing it to the web-standard Response constructor:

```text
storage key -> await readPdf() -> Buffer -> Uint8Array -> Response body
```

Why the PDF response needs headers
==================================

The response body is only raw bytes. The bytes do not tell HTTP clients how the server intends them to be handled, so the response adds metadata through HTTP headers.

Content-Type: application/pdf tells the browser that the bytes represent a PDF. Without it, the browser may treat the response as generic binary data, download it, refuse to preview it, or give a future viewer the wrong media type.

Content-Disposition: inline; filename="safe-name.pdf" tells the browser that the PDF may be displayed inside the browser and supplies a safe filename for download/save actions. Without it, a browser may still display the PDF because of Content-Type, but display-versus-download behavior and the suggested filename become browser-dependent. Using attachment instead of inline would normally force a download.

The filename must be sanitized before being inserted into Content-Disposition. Database filenames are user-controlled upload metadata and could contain quotes, slashes, newlines, control characters, or non-ASCII characters that do not safely belong in a raw HTTP header. The current safe-name.pdf value is only a placeholder; replacing it with a sanitized original filename is still part of this endpoint step.

The status code is not a header. status: 200 says the request succeeded, while the two headers describe the successful response body. Similarly, the route returns a JSON 404 response for a genuinely missing resource. We return a 404 response rather than throwing the number 404.

Why this endpoint returns 404
=============================

The PDF endpoint returns 404 when the requested PDF resource is not available to the authenticated user. This intentionally covers several cases:

```text
No document row with that ID
-> 404

The document exists but belongs to another user
-> 404

The document row exists but has no storage key
-> 404

The storage key exists but the physical PDF is missing (ENOENT)
-> 404
```

Missing and foreign documents use the same response because returning 403 for a foreign document would confirm that the guessed document ID exists. Returning the same 404 avoids leaking another user's resource existence.

For a missing physical file, 404 is also accurate because the specific PDF resource requested by the client cannot be found, even if its database metadata still exists.

We do not convert every error into 404:

```text
ENOENT / genuinely missing resource
-> 404 Not Found

Filesystem permission failure
-> server error

Database unavailable
-> server error

Storage corruption or unexpected programming error
-> server error
```

Calling all errors 404 would hide real operational problems and mislead both the user and developer. The route therefore catches only the known missing-file error and rethrows unexpected failures so normal server error handling can treat them as 500-level problems.

Step 2: Next PDF proxy route
============================

Created web/src/app/api/documents/[id]/pdf/route.ts, which gives the browser a same-origin GET /api/documents/:id/pdf URL.

```text
Browser requests the Next PDF URL
-> proxy.ts checks whether a session cookie is present
-> Next reads the HttpOnly cookie server-side
-> Next forwards the cookie to Hono
-> Hono requireAuth validates the session in PostgreSQL
-> Hono checks ownership and reads storage
-> Next passes the PDF response stream back to the browser
```

proxy.ts is only an optimistic cookie-presence check. A present cookie could still be invalid or expired. Hono's requireAuth performs the real authentication, and its ownership-scoped document query decides whether the user may access the PDF.

The Route Handler uses API_BASE_URL rather than NEXT_PUBLIC_API_BASE_URL. API_BASE_URL stays in server code, while NEXT_PUBLIC variables can be exposed to browser JavaScript. The browser therefore knows only the same-origin Next URL and does not need the internal Hono URL.

Passing through Hono responses
==============================

The route returns response.body directly. This is a stream, so Next passes bytes onward as they arrive instead of buffering another complete PDF copy. It preserves the response status and the Content-Type, Content-Disposition, and Content-Length headers needed by the browser.

fetch does not throw merely because Hono returns 401, 404, or 500. Those are completed HTTP responses, so Next passes their status and body through normally.

Handling a failed Hono connection
=================================

fetch throws when Next receives no HTTP response, for example when Hono is stopped, the connection is refused, or the connection breaks. The route catches this network-level failure, records the detailed error in server logs, and returns:

```text
502 Bad Gateway
{ "error": "Document service is currently unavailable" }
```

502 is appropriate because Next is acting as a gateway: Next received the browser request, but its upstream Hono service could not be reached. This is not a 404 because a connection failure does not prove that the document is missing. The internal network error is not sent to the browser because it may reveal implementation details and is not useful to the user.

Step 3: React-PDF and PDF.js compatibility
==========================================

Installed and exactly pinned these packages inside the web workspace:

```text
react-pdf 10.4.1
pdfjs-dist 5.4.296
```

React-PDF 10.4.1 declares pdfjs-dist 5.4.296 as its exact PDF.js dependency. The repository root currently has pdfjs-dist 6.2.108 for other code, but the web viewer must not resolve that incompatible version. PDF.js checks that its main library and worker versions agree; mixing versions can produce a worker/API version mismatch and prevent rendering. Pinning pdfjs-dist directly in web makes the viewer's dependency explicit and stable.

Created pdf-page.tsx as the browser-only module that imports React-PDF's Document, Page, and pdfjs. It configures the worker with:

```text
new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString()
```

This lets the Next bundler emit and reference the worker from the installed local package. It does not depend on an external CDN, does not need a hard-coded public worker URL, and stays aligned with the pinned PDF.js version.

The worker configuration intentionally lives in the same module that renders Document and Page. React-PDF warns that configuring workerSrc in an unrelated setup module can be overwritten because of module execution order.

Created pdf-page-client.tsx as an SSR-disabled dynamic wrapper. PDF.js needs browser APIs and a Web Worker, so the worker-owning component must not run during Next server rendering:

```text
Server-rendered document workspace
-> PdfPageClient dynamic boundary with ssr: false
-> browser loads pdf-page.tsx
-> local PDF.js worker starts
-> React-PDF loads and renders the PDF
```

The text-layer and annotation-layer styles are imported now because later citation selection, text highlighting, and PDF links depend on those React-PDF layers being positioned correctly.

The component is configured but not yet connected to the document workspace. The upcoming viewer step will pass /api/documents/:id/pdf as fileUrl and add page navigation, sizing, loading, errors, and citation highlighting.

Step 4: PDF viewer component structure
======================================

Created three empty component files so the real viewer can be implemented one responsibility at a time:

```text
pdf-viewer.tsx
-> owns the interactive viewer state and controls

pdf-document.tsx
-> configures React-PDF/PDF.js and renders the actual document pages

pdf-viewer-client.tsx
-> provides the Next dynamic import boundary with SSR disabled
```

The viewer UI belongs inside the existing /documents/:id workspace page. The /api/documents/:id/pdf route is not a visual page; it is the protected binary file source consumed by the viewer.

The existing pdf-page.tsx and pdf-page-client.tsx files remain untouched while we build the new structure. Removing or replacing them before the new viewer works would make it harder to compare the simple setup with the completed multi-page viewer.
