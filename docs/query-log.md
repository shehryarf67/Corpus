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

### Real natural-language retrieval test

Ran POST /query against the fully ingested paper with the question: "What two networks are included in the proposed framework?" The endpoint embedded the question and returned five real chunks from the selected document. The relevant page 3 chunk states that the left side is the inner training network and the right side is the super network controlling bit assignment. It appeared at rank 4 with similarity about 0.219.

Result: recall at 5 passed because the answer-bearing source was present in the top five, but ranking quality was only moderate because three chunks ranked above it and one of those was a clearly irrelevant reference fragment. This is a useful honest baseline: vector retrieval is functionally complete, but vector-only MiniLM retrieval is not automatically high precision. Context construction can proceed, while later hybrid keyword search, reranking, and retrieval evals should target this ranking weakness.

---

## Context construction test

Added `context.test.ts` for buildContext. The main test supplies two RetrievedChunk objects and verifies that retrieval order is preserved, labels become S1 and S2, snake_case database fields map to camelCase source fields, a real page number is formatted correctly, a null page becomes `Page Unknown`, source sections are separated by two newlines, and similarity metadata is preserved. A second test verifies that no retrieved chunks produces an empty context string and empty sources array. TypeScript compilation passed and the targeted context suite passed 2/2.

---

## Answer prompt builder

Added `lib/prompt.ts` with buildAnswerMessages(question, context). It returns the two ChatMessage objects expected by Ollama: a reusable system message containing grounding, insufficient-context, citation, and document prompt-injection rules, followed by a user message containing the labelled document context and question. The helper only builds messages and never calls Ollama.

Exported ChatMessage from generation.ts so prompt.ts and chat() share one checked message shape. Also exported ContextSource and BuiltContext, then corrected the in-progress queryDocument result to return the built context and ContextSource array instead of an object property named retrievedChunks that did not match its declared return type. TypeScript compilation and the existing context tests pass.

Added `prompt.test.ts`. It verifies that exactly two messages are produced in system/user order, the system message contains grounding, missing-answer, citation, and document-instruction safety rules, and the request-specific context and question appear only in the user message. A second test checks that empty context is preserved cleanly so queryDocument can handle the no-source case. TypeScript compilation passed and the prompt suite passed 2/2.

---

## Ollama answer generation wired into queryDocument

queryDocument now continues after context construction: it calls buildAnswerMessages(question, context), passes those messages to the existing Ollama chat helper, and returns `{ answer, sources }`. If retrieval returns no chunks, it skips Ollama and returns a fixed no-searchable-content answer with an empty source list. The query route did not need generation logic because it already returns whatever queryDocument resolves to.

TypeScript compilation passed and the focused context plus prompt suites passed 4/4. Ran a real POST /query request against the ingested paper using: "What two networks are included in the proposed framework?" Ollama produced the substantively correct answer: the inner training network and super network.

The live test also found the next roadblock. Ollama cited `[S3 | Page 7]`, but S3 was an irrelevant reference fragment; the actual supporting result was S4 on page 3. It also copied the context header format instead of citing only `[S4]` as instructed. This proves generation is connected and can use retrieved content, but raw model-written citations cannot be trusted yet. The next step is to tighten citation formatting and add server-side citation extraction/validation so only labels that map to real supplied sources are accepted. Retrieval ranking also contributed because the correct source was only fourth.

---

## Clearer source boundaries and deterministic generation

Replaced context headers like `[S4 | Page 3]` with explicit `<source id="S4" page="3">...</source>` blocks. The wrapper makes source boundaries and metadata clearer while the prompt separately requires answer citations in the exact `[S4]` form. Added instructions not to copy the XML-like wrapper or include page numbers inside answer citations. Updated the context and prompt tests for the new format.

Set Ollama temperature to 0 in generation.ts. Grounded document answering benefits from consistency rather than creative variation, so this reduces random wording and source-label changes between identical requests. It does not guarantee factual or citation correctness by itself.

TypeScript compilation and the focused context/prompt suite passed 4/4. Repeated the exact same real question. The answer again correctly identified the inner network and super network, and source attribution improved from the wrong S3/page 7 to the correct S4/page 3. However, Ollama wrote `source id="S4", page=3` instead of the requested `[S4]`. The important evidence selection improved, but exact citation output still cannot be trusted without normalization and validation in server code.

---

## Citation syntax normalization and label validation

Added `lib/citations.ts` with validateCitations(rawAnswer, availableSources). The available ContextSource labels form an allow-list for this one request. The helper first normalizes the model variants we have actually observed, including `source id="S4", page=3` and the old `[S4 | Page 3]`, into canonical `[S4]` markers. It then extracts every canonical marker, keeps valid labels once in first-citation order, removes labels that were never supplied, and returns only the source objects actually cited by the answer. Unknown labels are also returned internally as invalidLabels and queryDocument logs them.

Connected validation immediately after chat() in queryDocument. The API now returns the normalized answer and cited sources rather than all five retrieved candidates. This validates that a label exists in the supplied context, but does not yet prove that the source content semantically supports the claim.

Added citation tests for valid repeated labels, invented labels, the real Ollama source-id syntax, and answers with no citations. TypeScript compilation passed and the focused citation/context/prompt suite passed 7/7. Repeated the real HTTP question once more: the API returned `According to [S4]...`, returned only source S4, and mapped it to the correct page 3. The normalization and existence-validation path now works end to end.

---

## Postgres keyword retrieval

Added and applied migration `005_chunk_keyword_search.sql`. It adds a stored generated `search_vector` tsvector column based on each chunk's English-normalized content plus a GIN index. Existing chunks were populated automatically by Postgres, and future inserts do not need to provide this field because it is generated from content.

Added KeywordRetrievedChunk separately from the vector RetrievedChunk type. Keyword results carry `keyword_score` from ts_rank_cd, not cosine similarity. Keeping separate names matters because those score scales mean different things and must not be added directly.

Added Chunks.searchByKeyword(documentId, question, limit). It scopes matches to one document, limits results from 1 to 50, returns no candidates for blank input, and ranks matching chunks by Postgres full-text score. The helper returns only database candidates and is not connected to queryDocument or RRF yet.

The first implementation used websearch_to_tsquery. Its controlled exact-term test passed, but the real natural question returned zero rows because meaningful terms were combined too strictly: no single chunk contained every normalized word from the question. Fixed this by letting Postgres normalize the question into safe lexemes and joining those lexemes with OR before matching. This favors candidate recall; RRF and reranking will narrow the broad results later. Questions containing only English stop words are handled without creating invalid tsquery syntax.

Added `retrieval.integration.test.ts`. It verifies a matching keyword chunk is found, chunks from another document are excluded, the score is positive, blank questions return no rows, and stop-word-only questions return no rows. TypeScript passed and the targeted real-Postgres suite passed 3/3.

Ran the paper baseline question against existing generated search vectors. Keyword search ranked the correct framework chunk 5 on page 3 first with score 1.2 and the even more explicit chunk 6 on page 3 second with score 1.1. Vector-only search had placed chunk 5 fourth. This is exactly the complementary signal hybrid retrieval needs, but no fusion is wired yet.
