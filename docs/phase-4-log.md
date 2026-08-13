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
