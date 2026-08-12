ApiError
-> represents backend HTTP failures

request<T>()
-> standardizes Next -> Hono communication

endpoint wrapper
-> describes one specific backend contract

Server Component / Action
-> uses that contract to implement application behaviour

Phase 2 real document contract
================================

The backend document GET routes now return one consistent camelCase shape:

```text
id
title
filename
mimeType
uploadedAt
status
error
chunkCount
pageCount
```

Documents.listForUser(userId) builds the library rows. Documents.getDetailForUser(id, userId) builds the same shape for one owned document.

Both queries use separate LATERAL subqueries for latest job and chunk statistics. This avoids join fan-out. If jobs and chunks were joined directly, each job could be repeated once per chunk and COUNT(*) could become incorrect.

The latest job is selected using created_at DESC and id DESC with LIMIT 1. Chunk count uses COUNT(*). Page count temporarily uses MAX(page_number), with zero for documents that do not have chunks yet.

MAX(page_number) is only a temporary page count. It can undercount PDF pages that produced no chunks. The long-term fix is to persist the real PDF page count during ingestion.

Phase 2 document read integration tests
=======================================

Added documents-read.integration.test.ts using real Postgres and the real authenticated Hono documents router.

The tests prove:

- listForUser returns only the signed-in user's documents
- chunkCount is calculated from the document's chunk rows
- pageCount temporarily uses the highest chunk page number
- the newest job supplies status and error instead of an older failed job
- list and detail endpoints return the agreed camelCase response contract
- an owned document can be read
- a foreign document and a random missing ID return the same 404 body

The latest-job timestamps are set explicitly in the fixture. This avoids a flaky test where two jobs created in the same clock tick could rely on random UUID ordering.

Phase 2 frontend document API wrappers
======================================

Added the frontend copies of the backend document contract to web/src/lib/api.ts:

```text
DocumentJobStatus
DocumentResponse
DocumentsResponse
SingleDocumentResponse
```

Added getDocuments() for GET /documents and getDocument(documentId) for GET /documents/:documentId. Both use the existing request<T>() helper, so the Next server automatically forwards the session cookie to Hono, disables caching, parses JSON, and turns non-success responses into ApiError.

getDocument() URL-encodes the document ID before placing it in the path. A backend 404 is deliberately not converted here. The future detail page will catch ApiError with status 404 and call Next's notFound().

These wrappers describe transport data only. They do not yet map backend job statuses into the library UI's temporary ready/indexing/failed labels, and the pages still use mock documents at this checkpoint.

Phase 2 real document library
=============================

Replaced MOCK_DOCUMENTS on web/src/app/documents/page.tsx with getDocuments(). The authenticated Server Component now receives only documents returned for the current user by Hono.

Backend job states map to the library presentation as follows:

```text
pending or no job -> waiting to index
parsing           -> reading PDF
embedding         -> building search index
done              -> searchable card and document link
failed            -> failure message and no document link
```

Only done documents contribute to the indexed-passage total. Only done documents link to their workspace because querying an unfinished document would have no complete search index.

Removed the mock-only questionCount and lastAskedAt display. The real contract does not provide those fields yet, so cards truthfully show their relative upload time instead. Also removed the non-functional Retry button rather than presenting a fake operation.

PagePreview remains a deterministic placeholder because PDFs are stored but no thumbnail endpoint exists yet. Document IDs, titles, filenames, job state, counts, errors, and timestamps now come from the real API.

Phase 2 real document detail lookup
===================================

Replaced findMockDocument(id) in the workspace page with getDocument(id). The dynamic URL ID now goes through Next's authenticated API helper to GET /documents/:documentId, where Hono verifies the session and scopes the lookup to that user.

Added a small loadDocument() helper around the transport call:

```text
successful response -> return response.document
ApiError 404        -> Next notFound()
any other error     -> rethrow to documents/error.tsx
```

Missing documents and documents owned by another user intentionally produce the same not-found UI. Network, database, and backend 500 failures are not changed into 404s because that would hide a real outage behind a misleading Document not found message.

Only the document lookup and top-bar metadata are real at this checkpoint. The paper pane and example chat inside the workspace are still hard-coded presentation and must be removed or replaced in the next step.
