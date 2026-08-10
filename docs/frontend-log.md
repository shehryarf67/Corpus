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
