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
