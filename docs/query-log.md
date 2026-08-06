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

---

## Reciprocal Rank Fusion wired into queryDocument

Added `lib/rrf.ts` with fuseWithRRF(vectorResults, keywordResults). RRF ignores incompatible raw cosine and keyword score scales. For each list position r it adds `1 / (60 + r)` to the chunk. A chunk found by both searches gets both contributions. A Map keyed by chunk id deduplicates overlaps while retaining vector position, keyword position, raw scores, and final rrfScore. Deterministic position and chunk-index tie breakers keep repeated output stable.

Added FusedChunk as the honest post-fusion representation. Updated buildContext to accept vector-only or fused chunks and allow null similarity for keyword-only candidates. Context still does not expose retrieval scores to Ollama; scores only control candidate order.

Updated queryDocument to start keyword search while the question embedding is generated, retrieve the top 20 candidates from each strategy, fuse them, and pass only the fused top 5 to context construction. Broad candidate retrieval targets recall; the final five limit keeps Ollama context focused.

Added `rrf.test.ts`. Tests prove that a chunk found by both lists receives both contributions and is deduplicated, chunks found by only one strategy remain eligible, the exact rank formula is correct, and input arrays are not mutated. TypeScript passed, focused RRF/context/prompt/citation tests passed 10/10, and keyword database tests passed 3/3.

Directly inspected the real paper's fused ranking for the baseline question. The correct chunk 5 moved from vector rank 4 and keyword rank 1 to fused rank 2. Chunk 4 remained fused rank 1 because it was vector rank 1 plus keyword rank 4, producing the same RRF score as chunk 5; the deterministic tie breaker kept chunk 4 first. The more explicit chunk 6 was fused rank 4. Hybrid retrieval therefore improved the known correct source from rank 4 to rank 2, but did not make it rank 1. This is a real measured improvement, not a perfect result, and reranking is still needed for direct-answer precision.

The live generated answer was factually correct but omitted a citation marker on this run, so citation validation returned no sources. That is a separate model compliance issue: the fused top five contained the correct page 3 chunks, but the model did not emit a label to map. Do not confuse missing model citation syntax with retrieval failure.

---

## Multi-question hybrid retrieval evaluation on test_pdf.pdf

Confirmed that `docs/test_pdf.pdf` and the PDF fixture used by the complete ingestion test have the exact same SHA-256 hash. The already-ingested 22-chunk document is therefore a valid database representation of the user's test PDF, not merely a similar paper. Rendered and visually reviewed all seven pages to establish ground truth, then mapped verified page facts to actual stored chunk indexes.

Added `eval/retrieval-dataset.ts` with eight questions covering authorship, model-compression directions, framework networks, subgroup bit choices, non-differentiable quantization backpropagation, evaluation tasks, group-number performance, and knowledge-distillation conclusions. Each case records accepted chunk indexes and the visually verified PDF page. Adjacent chunks are both accepted when either contains valid evidence.

Added `eval/retrieval.ts` and `npm run eval:retrieval`. The harness embeds all questions as one batch, runs vector top 20 and keyword top 20, fuses them with the real RRF helper, and records the first accepted rank plus top-five chunk indexes for every strategy. It calculates recall@5 and MRR without calling Ollama, keeping retrieval quality separate from generation behavior. EVAL_DOCUMENT_ID can select another ingested copy; otherwise the script finds the latest ingested test.pdf/test_pdf.pdf.

Measured results across eight questions:

- Vector: recall@5 0.750, MRR 0.549.
- Keyword: recall@5 1.000, MRR 0.667.
- Hybrid RRF: recall@5 1.000, MRR 0.635.

Hybrid improved over vector on both metrics and never ranked the accepted evidence lower than vector on this dataset. It recovered both vector misses into the top five: the authorship source moved from rank 6 to 4, and the two-network source moved from rank 7 to 3. The quantization backpropagation source moved from rank 4 to 2. Other already-strong questions stayed at or near their vector rank.

Important honest result: keyword-only MRR was 0.667, slightly better than hybrid's 0.635. These questions are grounded closely in one technical paper's wording, which favors full-text search. Hybrid still has the safer recall profile and should handle paraphrases better, but this small dataset does not prove that RRF always beats each individual strategy. This is now the pre-reranker baseline. Reranking is justified because hybrid consistently finds the evidence in the top five but often does not put the most direct evidence first.

---

## Local cross-encoder reranking

Added `lib/reranker.ts` using `Xenova/ms-marco-MiniLM-L-6-v2`. Unlike the embedding model, the reranker reads the question and one candidate chunk together. It returns one relevance score for every pair, then sorts the candidates by that score. This is slower than vector or keyword retrieval, so it only receives the best 15 RRF candidates. Its best five are sent into `buildContext()` and then Ollama.

The tokenizer and model are lazy-loaded on the first non-empty request and their promises are reused afterwards. Inputs are padded and truncated to the model's 512-token limit. We use the raw sequence-classification logits directly because only their order matters for candidates belonging to the same question. RRF score and chunk index are deterministic tie-breakers.

Separated `attachRerankerScores()` from model execution. This lets the fast unit suite test sorting, tie-breaking, missing-score errors, input immutability, and empty candidates without downloading or loading the model. Added a separate `npm run test:reranker` smoke test for the real model. It asks which planet is known as the Red Planet and confirms that the Mars passage ranks above the Saturn passage.

TypeScript passed, all 36 fast tests passed, and the real model smoke test passed 1/1. The first model run initially failed because the sandbox blocked its Hugging Face download. After network permission was granted, the model downloaded, cached locally, and passed in about nine seconds.

Extended `eval/retrieval.ts` with reranked ranks, top-five results, recall@5, and MRR so we can compare vector, keyword, hybrid RRF, and reranked retrieval on the same eight test-PDF questions. That database evaluation could not run during this step because Postgres on localhost:5432 was stopped and the Docker engine was not running. The pre-reranker baseline remains recorded above; reranked PDF metrics still need one run after Docker/Postgres is available.

The reranked PDF evaluation was later run successfully. Reranked retrieval kept recall@5 at 1.000 and improved MRR from hybrid RRF's 0.635 to 0.813. This means every accepted source remained in the top five while the correct evidence generally moved closer to rank one.

---

## Conversation storage

Added migration `006_conversations.sql`. A conversation represents one chat about one document. A message belongs to a conversation and stores a role of either `user` or `assistant`, its text content, and its creation time. They are separate tables because one conversation can contain many messages.

Added `ConversationRow`, `MessageRow`, and `MessageRole` types in `db.ts`. Added simple helpers to create and retrieve conversations, save messages, and load a conversation's messages from oldest to newest. Empty messages are rejected before a database query is made.

Both foreign keys use cascade deletion. Deleting a conversation removes its messages, and deleting a document removes its conversations and therefore their messages. Applied the migration successfully. TypeScript passed and the focused Postgres conversation tests passed 3/3, covering ordered history, empty-message rejection, and cascade deletion.

### Conversation-aware query endpoint

Kept HTTP work in `routes/query.ts`: reading JSON, validating `documentId`, `question`, and optional `conversationId`, selecting HTTP error codes, and returning JSON. Moved the actual conversation workflow into `services/query.ts` because creating or loading conversations, storing messages, and running RAG are application logic rather than HTTP logic.

Added `queryConversation()` around the existing `queryDocument()`. A request without a conversation ID creates a new conversation. A request with an ID resumes it. The service rejects a conversation tied to another document, loads previous history before the new question is stored, saves the user message, runs the existing query pipeline, saves the assistant answer, and returns `conversationId` with the answer and sources. The loaded history is intentionally not used yet; the next query-rewriting step will consume it.

Added `QueryConversationError` so the service can report expected 400 and 404 conversation errors while the route remains responsible for turning them into HTTP responses. TypeScript passed and the focused conversation database tests still passed 3/3.

### History-aware rewriting and generation

Added `Messages.getRecentByConversationId()`. The database still stores every message, but only the latest 10 messages are loaded for model input by default. The SQL selects the newest messages first and then returns that small selection in natural oldest-to-newest order.

Added `lib/rewrite.ts`. `rewriteQuestion(question, history)` asks Ollama to resolve follow-up references and return one standalone search question without answering it. A first question with no history is returned unchanged, avoiding an unnecessary model call.

Updated the query flow to keep two question values. `originalQuestion` is exactly what the user asked. `retrievalQuestion` is the standalone rewrite. Embedding, keyword search, and reranking use the rewrite. Final answer generation uses the original question, recent conversation history, and retrieved document context. The stored user message remains the original wording, not the internal rewrite.

Updated `buildAnswerMessages()` to place previous user and assistant messages before the current grounded question. Added tests for rewrite prompt contents, the no-history shortcut, generation message order, and recent-history selection. TypeScript passed, all fast tests passed 39/39, and focused conversation Postgres tests passed 4/4. A full two-request HTTP conversation test remains the next separate verification step.

### Multi-turn end-to-end verification

Ran the full automated suite after wiring conversations: 39/39 fast tests passed, the real reranker model test passed 1/1, and all Postgres integration tests passed 12/12.

Then ran a real two-request HTTP conversation against the ingested `test_pdf.pdf`. The first request asked `What is AQ-BERT?` and returned conversation ID `54eca87b-6c59-406b-ae65-36cd0e3fc944`. The second request reused that ID and asked `Which four NLP tasks was it evaluated on?`. It correctly answered SST-2, MNLI, CoNLL-2003, and SQuAD, exactly matching stored chunk 12 on page 5.

Database inspection confirmed four messages were saved in the correct order: user, assistant, user, assistant. A direct rewrite check changed `What tasks was it tested on?` into a standalone question explicitly naming AQ-BERT. This verifies history loading and reference resolution separately from the successful retrieval result. The generated answers omitted citation labels on this run, so the validated `sources` arrays were empty; factual retrieval and multi-turn behavior passed, while Ollama citation-format compliance remains imperfect. Removed the temporary test conversation and verification scripts after the checks.

---

## Ollama answer streaming parser

Added `chatStream()` beside the existing non-streaming `chat()` helper. It requests `stream: true`, reads Ollama's NDJSON response as bytes, decodes those bytes into text, keeps incomplete JSON in a buffer, parses only newline-completed objects, and yields each non-empty `message.content` piece through an async generator. It also handles a final object without a trailing newline, streamed Ollama errors, HTTP errors, missing response bodies, and reader-lock cleanup.

Added four controlled parser tests covering multiple NDJSON lines, JSON split across network reads, a final object without a newline, and a streamed error. All 4/4 passed. Added a separate real-model smoke test and `npm run test:stream`; it consumed an actual streamed response from local Ollama and passed 1/1. The real check took about 18 seconds. No SSE route or `prepareQuery` refactor was added at this checkpoint.

### prepareQuery refactor

Refactored the query service so shared preparation is separate from final answer generation. `prepareQuery()` now creates or resumes the conversation, validates document ownership, loads recent history, saves the original user message, rewrites the question, runs embedding plus vector and keyword retrieval, applies RRF and reranking, builds context, and builds Ollama messages. It returns only `conversationId`, `messages`, and `sources`; it does not generate or save an assistant answer.

`queryConversation()` now calls `prepareQuery()`, handles the no-searchable-content case, calls the existing non-streaming `chat()`, validates citations, saves one complete assistant message, and returns the response. This preserves current `/query` behavior while giving the future SSE path the same prepared messages and sources for `chatStream()`.

Added a focused Postgres integration test proving that preparation retrieves the correct source and stores only the user message. TypeScript passed, all unit tests passed 43/43, and all Postgres integration tests passed 13/13. A real `/query` request against `test_pdf.pdf` correctly returned SST-2, MNLI, CoNLL-2003, and SQuAD. Database inspection confirmed exactly one user and one assistant message, and the temporary conversation was deleted. Ollama again omitted citation labels, so sources were empty even though the factual answer matched the document.

### Streaming query service

Added `services/query-stream.ts` without adding an SSE route. `streamPreparedQuery(prepared)` consumes the existing `PreparedQuery` and produces normal typed application events. The event order is conversation, generating status, one or more token events, finalizing status, then done. The done event contains the final validated answer and cited sources and is emitted only after the complete assistant message is saved.

The service keeps a `rawAnswer` string while forwarding each `chatStream()` text piece. After Ollama finishes, it validates citations against `prepared.sources`, logs invented labels, and saves one complete assistant row rather than one row per token. The no-source path skips Ollama but follows the same event shape using the fixed no-searchable-content answer.

No `finalizeQuery()` helper was introduced. The existing non-streaming `chat()` path and its handling remain in `queryConversation()`, while the streaming path performs its own validation and persistence. Streaming errors deliberately propagate from the service for the future SSE route to catch. A mid-stream failure therefore produces no done event and stores no partial assistant answer.

Added focused Postgres tests for normal event ordering and persistence, the no-source shortcut, and mid-stream error propagation. All streaming-service tests passed 3/3, TypeScript passed, and the complete unit suite passed 43/43. Docker Desktop had to be started because Postgres was initially unavailable. No HTTP or SSE route was created.

### SSE query route

Added `POST /query/stream` to the existing query route. The original `POST /query` endpoint remains unchanged. The streaming route accepts the same `documentId`, `question`, and optional `conversationId`, performs the same validation, and calls `prepareQuery()` before opening SSE. This preserves normal HTTP 400, 404, and 500 responses for validation or preparation failures.

After preparation succeeds, Hono's `streamSSE()` opens a `text/event-stream` response. The route consumes `streamPreparedQuery()` and translates each typed service event into SSE by using its `type` as the SSE event name and JSON-stringifying the remaining fields as data. The resulting protocol includes conversation, status, token, and done events.

Errors thrown after SSE starts are caught inside the stream callback because the HTTP status can no longer be changed. The route logs the internal error and sends a safe `error` event with `{"message":"Query stream failed"}`. It does not expose Ollama or database details to the client. The streaming service remains responsible for avoiding partial assistant persistence.

Added a real Hono route integration test using Postgres and a controlled Ollama NDJSON stream. It verified the SSE content type, exact success event order, event data, citation-preserved final answer, conversation ID, and stored user/assistant messages. It also verified that a simulated Ollama failure produces conversation, status, and error events and stores only the user message. The route test passed and TypeScript passed.

### Real end-to-end query streaming test

Added `test/query-stream.e2e.test.ts` and `npm run test:query-stream:e2e`. Unlike the controlled route test, this uses the real ingested `test_pdf.pdf`, real Postgres retrieval, the local embedding and reranking models, real Ollama `chatStream()`, the actual Hono `/query/stream` route, and incremental SSE response reading.

The test verifies that the response is SSE, conversation and generating status arrive first, more than one real token event is produced, finalizing status and done arrive last, no error event appears, and the final answer contains SST-2, MNLI, CoNLL-2003, and SQuAD. It also confirms that the done conversation ID matches the first event, the database contains exactly one user and one assistant message, and the saved assistant content equals the final done answer. The temporary conversation is deleted afterward.

The real end-to-end streaming test passed 1/1 in about 122 seconds, and TypeScript passed. Backend streaming is now verified from request through persistence. The frontend stream reader remains intentionally deferred until frontend development begins.

---

## Full query quality evaluation harness

Added `eval/query-dataset.ts` with direct factual, explanation, unanswerable, and multi-turn cases grounded in the actual stored PDF chunks. Expected answers use fact groups with acceptable wording alternatives rather than requiring one exact generated sentence. The dataset covers authors, compression directions, framework networks, subgroup bit widths, STE backpropagation, evaluation tasks, group-count performance, knowledge distillation, two unanswerable questions, and two multi-turn conversations.

Added deterministic scoring in `eval/query-scoring.ts` for fact coverage, refusal detection, and canonical citation presence. Added scoring tests, which passed 3/3. Added `eval/query.ts` and `npm run eval:query` to run real conversation queries, score each turn, report aggregate correctness, citation, expected-page citation, refusal, follow-up, and latency metrics, and delete each evaluation conversation afterward. `EVAL_CASE_ID` runs one named case and `EVAL_CASE_LIMIT` runs a short prefix. The runner prints progress per case and cleans its exact active conversation when interrupted with Ctrl+C.

Added `eval/query-stream.ts` and `npm run eval:query-stream` for first-response, first-event, first-token, total-duration, token-count, and answer fact-coverage measurements over the real SSE route. The representative evaluation-tasks run produced the first event at 1366 ms, first token at 2943 ms, 31 token events, completion at 8479 ms, and fact coverage 1.000.

The non-streaming evaluation-tasks smoke case also passed with fact coverage 1.000 and the correct four tasks. It took 99733 ms and again produced no citation, so citation presence and expected-page citation were both 0.000. Metrics with no applicable cases now display `-` instead of incorrectly looking like a zero score.

### Flaws exposed by the evaluation

The full baseline reached the multi-turn tasks case but one unrestricted Ollama call continued at 100% CPU for far beyond normal generation time. The run was interrupted and its exact orphaned evaluation conversation was deleted. This exposed that `chat()` and `chatStream()` currently set no maximum output-token count and no request timeout. A bad rewrite or answer can therefore consume CPU indefinitely. This is a production-code issue to fix collaboratively; no automatic production fix was kept.

The evaluation also confirmed the existing citation-compliance weakness: answers can be factually complete while Ollama omits citation labels, causing the validated sources array and citation metrics to remain empty. The quality harness now measures this explicitly instead of hiding it.

TypeScript passed after the evaluation-only changes. The scoring tests passed 3/3. Production generation, rewriting, query, and route behavior were not changed as part of this evaluation work.

---

## Generation safety and citation reliability follow-up

The query evaluation exposed that an Ollama request could run indefinitely and keep the CPU busy. Added operation-specific output and time limits in `lib/generation.ts`. Normal answer generation and streaming now default to a maximum of 512 output tokens and a 120 second total timeout. Query rewriting uses the same helper with a smaller maximum of 96 output tokens and a 30 second timeout because a rewrite should only be one short standalone question. Ollama receives the token limit through `num_predict`, while `AbortSignal.timeout()` stops a request that exceeds its allowed time.

These are output limits, not target lengths. Ollama can finish before reaching them. The current streaming timeout is one simple total timeout. Separate first-token and inactivity timeouts may be more precise later, but were intentionally not added yet.

Added focused generation tests proving that the default 512-token limit and the operation-specific 96-token limit are sent to Ollama. The focused generation suite passed 6/6 and TypeScript passed.

The evaluation also showed that a factually correct answer can omit citation labels because citation formatting is a model instruction, not a guarantee. Strengthened the answer system prompt with numbered rules: every factual claim needs a citation, only supplied source IDs may be used, multiple sources use `[S1][S2]`, page numbers and source wrappers are forbidden, and an insufficient-context answer uses one exact refusal without a citation. Added correct and incorrect citation examples because the local Llama model follows concrete output examples more reliably than a vague citation request.

Added `buildCitationRetryMessages()` and one retry in the non-streaming `queryConversation()` flow. After the first answer, citation validation already tells us whether no valid source was cited or an unknown label was invented. Either condition triggers exactly one correction request containing the original grounded prompt, the first answer, and the allowed labels. The retry asks only for citation correction and forbids new facts. A valid first answer does not pay for a second Ollama call.

A real evaluation of the four NLP tasks reproduced the missing-citation problem on the first answer, triggered the retry, and returned the correct answer with `[S1]`. Fact coverage, citation presence, and expected-page citation all scored 1.000. The tradeoff was latency: the complete request took about 120 seconds because Ollama generated twice. Prompt, citation, and generation tests passed, and TypeScript passed.

Important remaining consistency gap: the one-time citation retry currently exists only in the normal JSON query path. The SSE path streams tokens to the client immediately and validates the completed answer afterward, so it cannot silently replace already-streamed text with a corrected retry. The stronger original prompt does apply to both paths. Deciding how SSE reports or repairs a citation failure is still open.

---

## Query phase completion audit

### Implemented

- Query HTTP endpoint with document ID, question, and optional conversation ID validation.
- Query embeddings using the query embedding mode.
- Postgres cosine vector retrieval scoped to one document.
- Postgres full-text keyword retrieval with searchable text support.
- Reciprocal Rank Fusion combining vector and keyword rankings.
- Local cross-encoder reranking of the best fused candidates.
- Top-five context construction with stable source labels and page metadata.
- Grounded Ollama answer generation using the original question and retrieved context.
- Citation syntax normalization, allow-list validation, invented-label removal, and cited-source mapping.
- Strong citation prompt and one corrective retry for the non-streaming path.
- Conversation and message persistence.
- Recent-history loading, follow-up question rewriting, and history-aware answer generation.
- Backend token streaming from Ollama.
- SSE route with conversation, status, token, done, and error events.
- Unit, Postgres integration, real-model, SSE route, and real end-to-end streaming tests.
- Retrieval evaluations for vector, keyword, hybrid, and reranked strategies.
- Query quality evaluations for factual coverage, refusal behavior, citations, expected pages, follow-ups, latency, and streaming timing.
- Output-token limits and request timeouts for rewrite, normal generation, and streaming generation.

### Partially implemented

- Conversation memory is implemented as stored messages plus the latest 10 messages supplied to rewriting and generation. There is no long-conversation summarization, semantic memory, or user-level memory. This is enough for the current multi-turn document chat.
- Citations are complete on the backend for canonical labels and source metadata. The frontend behavior that turns a citation into a clickable PDF page and highlighted passage is not implemented because there is no frontend yet.
- SSE is complete and tested on the backend. The frontend SSE reader is intentionally deferred until frontend work starts.
- Evals are implemented and runnable. The retrieval comparison has measured results, but the full query dataset should be rerun after the timeout and citation changes. The README eval table still contains placeholders.
- Streaming answers use the stronger citation prompt and final validation, but do not have the non-streaming citation retry described above.

### Not implemented

- Multi-tenancy. The schema has no users or organizations, documents have no owner ID, routes have no authentication, and there are no Postgres row-level-security policies. The README currently claims multi-tenant isolation and RLS, so either this feature must be built or that claim must be removed until it is true.
- Frontend chat interface, SSE reader, conversation state, source list, PDF viewer, citation clicking, and passage highlighting.
- Small-to-big retrieval as described in the README. The current pipeline retrieves and sends the same chunks; it does not retrieve a small child chunk and expand it to a larger parent section.
- A complete post-fix query evaluation baseline across every case. The earlier full run was interrupted before the safety limits existed.

For the backend query MVP, the main retrieval, generation, conversation, citation, SSE, and evaluation pieces are now present. The clean next product phase is the frontend. If the README's production-style promises are the target, multi-tenancy and RLS should be implemented before deployment, and small-to-big retrieval should either be implemented or removed from the advertised feature list.
