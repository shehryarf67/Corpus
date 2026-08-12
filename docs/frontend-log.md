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
