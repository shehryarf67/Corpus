# Query phase log

This is the running log for the query side of the RAG pipeline. Keeping it separate from ingestion-log.md because ingestion prepares the searchable data once, while query runs every time the user asks a question.

Pipeline shape so far: POST /query -> validate documentId and question -> embed the question -> pgvector cosine search -> return the best matching chunks. Context building, Ollama generation, and citations are not wired yet.

---

## Query route and service boundary

The route receives HTTP data, validates documentId and question, calls queryDocument, and turns the result into JSON. It does not contain embedding or SQL logic.

queryDocument is the query orchestrator, similar in role to processIngestionJob on the ingestion side. At this stage it only embeds the question and asks Chunks.searchSimilar for the five closest chunks. Later the same function will build context, call Ollama, and return citations.

We do not create a jobs row for each question. Jobs currently track slow background ingestion work. A normal query is handled directly by the request. The earlier attempt to call Jobs.create(documentId, query) would also have stored the question in the job type field, since the second parameter is the job type, and the ingestion worker would never claim it.

---

## Query embedding

The existing embed function accepts an array, so one question is passed as [question] with input type query. It returns number[][] because a batch can contain multiple texts. The question vector is therefore embeddings[0]. We explicitly throw if that first vector is missing.

The local Xenova/all-MiniLM-L6-v2 model currently treats document and query input types the same, but retaining the distinction keeps the interface ready for an embedding provider that uses different modes. The question and stored chunks must always use the same embedding model and dimension or their vectors are not comparable.

---

## Vector formatting shared by ingestion and query

Moved formatEmbeddingForPgvector into lib/vector.ts. The model gives JavaScript a number[], while node-postgres sends pgvector values as bracketed text such as "[0.1,-0.2,0.3]". Ingestion and query both need this conversion, so it no longer belongs only to pdf/persist.ts. persist.ts re-exports it so existing callers and tests still work.

---

## RetrievedChunk and cosine retrieval

RetrievedChunk represents the useful chunk fields returned after Postgres compares stored embeddings with the question embedding. It is not another database table and is not persisted. It adds a calculated similarity field but leaves out embedding and created_at because the next query stages do not need them.

Chunks.searchSimilar takes documentId, queryEmbedding, and an optional limit. It verifies that MiniLM returned exactly 384 finite numbers, clamps the result count between 1 and 50, formats the question vector, and sends it to Postgres as a query parameter.

The SQL scopes rows to the selected document and ignores chunks without embeddings. `embedding <=> $2::vector` calculates cosine distance inside Postgres. Results are ordered by smallest distance, while `1 - distance` is returned as the more intuitive similarity value where a larger number means a closer match. LIMIT means only the best rows come back to JavaScript. We do not download every stored vector or calculate cosine similarity in a TypeScript loop.

The parameters are: $1 documentId, $2 formatted question vector, and $3 result limit. Parameterized values keep request data separate from SQL syntax.

---

## Verification

Added a real Postgres integration test with two controlled 384-dimensional vectors. Searching with the first vector must return its identical chunk first with similarity 1, ahead of the unrelated axis vector. This proves pgvector receives the query vector, calculates cosine similarity, orders the rows correctly, and respects the requested document. The targeted database suite passed 3/3, including this retrieval test, and TypeScript compilation passed.

Verification roadblock: the first database run could not connect because Docker was open but the corpus-db container itself was stopped. Started the existing container and reran the targeted persistence/retrieval suite successfully. The full non-database suite also hit the previously seen pdfjs-dist optional canvas binding problem under the current Node 24 install (`DOMMatrix is not defined`). That failure occurs while loading the PDF test files and is unrelated to the new query retrieval code; the embedding, persistence mapper, storage, TypeScript, and targeted real-pgvector checks completed successfully.
