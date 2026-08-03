# Ingestion phase log

This is just a running log of everything we figured out while building the ingestion pipeline (extract.ts, layout.ts, chunk.ts). Not a doc for anyone else, just so i can look back and remember where we got stuck and how we got out of it.

Pipeline shape so far: PDF buffer -> extract.ts (raw text fragments) -> layout.ts (lines -> paragraphs -> blocks) -> chunk.ts (blocks -> token sized chunks). Next step after this is embedding + persistence, not built yet.

---

## extract.ts

### Decision: pdfjs-dist over pdf-parse

pdf-parse only gives flat text per page, no font size, no position. Since the README promises structure aware chunking (headings, sections), we need font size and position to tell a heading apart from a paragraph. pdf-parse throws that away before we ever see it. pdfjs-dist gives raw text items with a transform matrix (position + font info), fontName, etc. More work to use, but it is the only one that can actually produce the signal the chunker needs.

### Roadblock: browser build vs legacy build

First attempt imported `pdfjs-dist` directly, which is the browser facing entry point (assumes a DOM / Web Worker). Wrong for a Node backend. Fix: import from `pdfjs-dist/legacy/build/pdf.mjs` instead, which is the build meant for non-browser environments.

### Roadblock: worker setup

pdfjs runs parsing in a Web Worker in the browser so the UI thread doesnt freeze. Node has no browser style Worker by default. First attempt pointed `workerSrc` at a CDN (unpkg) which is a bad idea for a backend, introduces a network dependency for something that should be fully local. Also tried `useWorkerFetch: false` which does nothing for this (that flag is about fetching fonts, not about disabling the worker). Fix: point `GlobalWorkerOptions.workerSrc` at the actual worker file sitting in node_modules using `import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')`. Resolves to a local file path, no CDN needed.

### Roadblock: TextItem type not exported

pdfjs doesnt export `TextItem` from its public entry point, it lives under an internal types path that isnt part of the supported API. Tried importing it directly from the internal path, tsc couldnt find the module. Fix: just declare our own minimal type (`PdfTextItem`) with only the fields we actually read (str, transform, fontName). More robust to version changes anyway since we're not depending on an unexported internal type.

### fontSize and isEvalSupported

pdfjs doesnt give font size directly, only the raw transform matrix `[scaleX, skewX, skewY, scaleY, x, y]`. Font size is derived from the scale components: `sqrt(scaleX^2 + skewX^2)` normally, falling back to the skewY/scaleY pair for edge cases.

Also tried passing `isEvalSupported: false` to getDocument (to avoid eval based font handling). Turned out this option doesnt exist anymore in pdfjs-dist v6, it was removed from the library entirely. Just dropped it, nothing to disable anymore.

### Rotation bug (found much later, while debugging layout.ts)

TextRun originally had no way to know if a fragment was rotated (like a sideways arXiv watermark on page 1 of preprints). This came back to bite us in layout.ts (see below). Fix applied in extract.ts: added `isRotated: boolean` to TextRun, computed from the angle of the transform matrix's x-axis basis vector (`atan2(skewX, scaleX)`). Upright text ~0 degrees, rotated text ~90 degrees. Anything more than 10 degrees off upright/upside-down gets flagged.

### Testing

Wrote extract.test.ts using node:test (no extra dependency, already have tsx). Checks: at least one run comes back, every run has valid text/page/fontSize/fontName, and font sizes actually vary (not a flat baseline) as a proxy check that we're really capturing the size signal, not silently flattening it. Fixture pdf lives at `server/src/lib/pdf/__fixtures__/test.pdf` (copied in, not referencing the docs/ folder, so the test doesnt depend on a path outside the server workspace).

---

## layout.ts

Goal: turn extract.ts's flat list of text fragments (TextRun[]) into structured Block[] (heading or paragraph, with page + char offsets), matching the `chunks` table schema.

### Fragment vs line vs paragraph vs block, the actual hierarchy

- TextRun (fragment): one raw piece of text from pdfjs, could be a word or a few words. Boundaries come from the PDF's own content stream (how the PDF producer emitted show-text calls), not anything semantic. Same sentence can be split into multiple fragments just because of a font change or kerning adjustment.
- Line: multiple fragments that share a y position, grouped by us.
- Paragraph: multiple lines grouped together based on gap size and font consistency.
- Block: a paragraph or heading, classified, with char offsets assigned. This is layout.ts's actual output.

Block came pretty late as its own type. Paragraph as its own type came even later, only once we actually sat down to write groupIntoParagraphs's signature and realized Block cant be the return type (it does two extra jobs a pure grouping function shouldnt do: heading/paragraph classification and char offsets, both need whole document context that a two line comparison doesnt have).

### PDF coordinate gotcha

PDF y axis grows upward, origin bottom left. Bigger y = higher up on the page. Opposite of screen coordinates. Sorting for reading order needs descending y (page -> descending y -> ascending x), not ascending. Easy first mistake to make.

### groupIntoLines

Accumulator pattern: sort fragments into reading order, walk through them, fold a fragment into the "current" line being built if its y is close enough (within LINE_Y_TOLERANCE, not exact equality, floating point noise means two fragments visually on the same line can have slightly different y). Otherwise close off current line, start a new one. Loop only closes a line when it hits a fragment that starts a new one, so the very last line needs a manual flush after the loop ends. Same shape shows up again and again through this whole file (paragraphs, columns, chunks later on), its the same "accumulate until told to stop, then flush" idea every time, just with a different stopping condition.

### groupIntoParagraphs

Same accumulator shape, but the "does this belong with what im building" check is different: gap size vs font size, not just "same value". Key mistake almost made here: thinking "different y between consecutive lines = new paragraph" would work. Wrong, because every line naturally has a different y from the line before it (thats just what going down the page means). The real check is whether the GAP is bigger than the *typical* gap (PARAGRAPH_GAP_FACTOR, relative to font size, not a fixed number), or whether the font size changed.

Needed a second piece of state alongside "current paragraph being built": `previousLine`, since Paragraph doesnt keep a y field (not meaningful once lines are merged) but the gap check needs the previous line's y specifically.

### Heading classification and char offsets

These need a whole document view (median font size across all lines, to know what "meaningfully bigger" means) so they cant live inside groupIntoParagraphs, which only ever compares two neighboring lines. Median computed once in layoutText, then heading threshold = baseline * HEADING_SIZE_FACTOR (1.3).

char_start/char_end are page relative (reset to 0 on page change), not document wide, since the chunks table has page_number as its own column separate from the offsets.

### Multi column bug (big one)

First layout.ts pass assumed single column reading order everywhere. Tested against a real 2 column academic paper (the arxiv pdf), and a title/abstract fragment ended up merged with unrelated body text because column 2's early lines have similar y to column 1's later lines, and plain y sorting doesnt know about columns at all.

Fix v1: hardcoded 2 column split. Compute one midpoint x from the narrow (non full width) lines bounding box, classify each as left or right, flush buffer as left-then-right whenever a wide line (title, header) interrupts the run.

Then realized: this assumes EXACTLY 2 columns. With 3+ columns the single midpoint lands inside the middle column and corrupts it, not just makes it worse, actively wrong (splits the middle column apart and merges pieces of it into both neighbors).

Fix v2 (generalized): instead of one hardcoded midpoint, find however many real column boundaries exist by sorting narrow lines' left edges and looking for gaps way bigger than the typical (median) gap. Reused the exact same "gap vs typical gap" pattern from groupIntoParagraphs, just applied along x instead of y. Added a minimum absolute gutter width too (MIN_GUTTER_GAP) so a near zero median gap (lines sharing an identical left edge) cant make the threshold ~0 and flag tiny noise as a new column.

This generalization was basically free once we had it, since findColumnBoundaries returning 0 boundaries just means "one column, dont reorder", which is exactly what we want as the fallback.

### Rotation bug (the second big one, sneakier)

After fixing the column bug, one test still failed: a bogus "heading" mixing an abstract sentence with the arXiv preprint watermark. Turned out this happens BEFORE column logic ever runs, in groupIntoLines itself. The watermark is rotated 90 degrees (runs vertically along the margin). pdfjs gives an anchor point for rotated text, not a "this text visually sits at this height" position the way it does for upright text. This particular watermark's anchor y (252.0) happened to coincidentally match a real unrolated line's y (252.7), well within LINE_Y_TOLERANCE, so they got fused into one Line.

Column reordering cant fix this since the damage already happened one stage earlier. Real fix: detect rotated fragments and drop them before line grouping ever runs (a sideways watermark isnt real content worth chunking anyway). Added `isRotated` to TextRun in extract.ts (see above), filtered in groupIntoLines with `runs.filter(run => !run.isRotated)` right at the top, before sorting.

Lesson from this one: when two separate bugs look similar (both involve the same watermark), dont assume fixing the first one fixes the second. Verify with a real test after each fix, dont assume.

### Testing

layout.test.ts checks: blocks are well formed (non blank text, valid page, charEnd > charStart), char offsets reset per page, the real title gets classified as heading, and specifically a regression test for the column/rotation bug (no block should contain both the watermark id and the unrelated abstract sentence it used to get merged with). Wrote this test BEFORE the column fix, watched it fail (red), then fixed reorderForColumns, still failed (still red, because of the separate rotation bug), then added the isRotated filter, went green. Good example of a fix not being complete just because you expected it to be, the test is what actually tells you.

---

## chunk.ts

Goal: pack Block[] into Chunk[] sized to fit an embedding token budget (~300-500 tokens per readme), matching the rest of the `chunks` table schema (content, page, char_start, char_end, chunk_index... embedding and id come later / are db generated, not our job).

### Why a block isnt a chunk

Blocks are structural units (one paragraph or heading), chunks are retrieval sized units. A block's length is whatever the author happened to write, nothing to do with what makes a good embedding. Tiny blocks (a lone heading) dont carry enough context alone, huge blocks dilute the embedding by mixing multiple ideas into one vector. Chunking is a genuinely different, later concern from layout, same reason extract.ts and layout.ts are separate files.

### countTokens and the encoder mistake

First version created and freed a new tiktoken encoder on every single call to countTokens. get_encoding() parses BPE merge tables, not cheap, and this function gets called a lot during packing. Fix: create the encoder once at module load (module level `const encoder = get_encoding(...)`), reuse it for every call, never free it (no natural "done with it" point in a long running server, unlike the per-call case which had an obvious but wasteful place to free).

### tiktoken installed in the wrong place

Installed at the repo root instead of the server workspace. This is an npm workspaces monorepo, every other pdf dependency (pdfjs-dist, pdf-parse, pg, voyageai) lives in server/package.json since thats the workspace that actually uses them. Fixed by uninstalling from root and reinstalling scoped with `-w server`.

### Chunk type: naming mistakes

First draft used snake_case (char_start, chunk_id, page_number) which doesnt match the rest of the file (Line/Paragraph/Block are all camelCase). DB columns are allowed to be snake_case, the TS type doesnt need to mirror that 1:1.

Bigger issue: `chunk_id` was the wrong CONCEPT, not just wrong casing. The db schema has two different things: `id` (a UUID, generated by the db itself on insert, chunk.ts never computes this) and `chunk_index` (a running per document counter that chunk.ts DOES need to produce, to preserve ordering and satisfy the unique(document_id, chunk_index) constraint). Naming a field `chunk_id` reads like its trying to be the db's own primary key, which isnt this module's job at all. Renamed to `chunkIndex` to match its real purpose.

### Design mistake: calling layoutText from inside chunk.ts

Original plan was to have groupIntoChunks call layoutText(fileBuffer) internally to get its own blocks, instead of taking blocks as a parameter. Wrong for the same reason extract.ts and layout.ts stayed separate: chunking is a separate pipeline stage (Parse -> Chunk -> Embed per our own architecture diagram), not something layout.ts's orchestrator should reach into. Concretely this would have: made testing chunk.ts in isolation impossible without going through full pdf parsing every time, forced groupIntoChunks to be async for no reason intrinsic to chunking itself, and killed reuse if a non-pdf source ever needs the same chunker.

Fixed by keeping groupIntoChunks(blocks: Block[]): Chunk[], not async, no PDF/buffer knowledge at all. The actual "call layoutText, then feed the result to groupIntoChunks" composition doesnt live in either file, it belongs to whatever eventually orchestrates the whole pipeline (the ingestion worker, not built yet). For now just used throwaway test scripts to verify chunk.ts against real blocks, same pattern used for extract.ts and layout.ts.

### Loop bugs on the way to the real algorithm

- First attempt started the packing loop at `i = 1`, skipping blocks[0] entirely. Unlike the line/paragraph loops (which need i=1 because they compare to the PREVIOUS item), this loop has nothing to compare against, every block just gets evaluated on its own, so it should start at i=0 (or better, `for (const block of blocks)`).
- `blocks[i]?.text` passed straight into countTokens, type error under noUncheckedIndexedAccess (comes back as `string | undefined`, countTokens wants a definite string). Same pattern as everywhere else in this codebase, fixed with `?? ''`.
- First attempt at the overflow condition was `buffer.length + tokenCount > MAX_CHUNK_TOKENS`. Wrong units entirely, buffer.length is a COUNT OF BLOCKS, not a token count. Adding a block count to a token count doesnt mean anything, this would almost never trigger a flush in practice since block count grows by 1 while token counts grow by dozens/hundreds. Needed an actual running token total tracked separately (`bufferTokenCount`), not derived from buffer.length.

### The actual condition

Not "does this block's token count roughly equal the budget", but "would ADDING this block's tokens to what's ALREADY accumulated push the running total past the budget". Requires a running total tracked alongside the buffer (bufferTokenCount), updated incrementally, not recomputed by re-counting the whole buffer's text every time.

### Oversized single block fallback

A block whose OWN token count already exceeds the budget cant just start a new chunk, that chunk would be oversized too. Needed a completely separate path:
1. Split the blocks text into sentences (regex on `.?!` followed by whitespace, lookbehind keeps the punctuation attached to the sentence it ends).
2. Pack those sentences using the SAME accumulate-until-budget-then-flush shape as groupIntoChunks itself, just generalized to operate on any array of small text units (reused as `packUnitsIntoPieces`, works for both sentences and the word level fallback).
3. Rare fallback: if a single "sentence" (by the simple regex rule) is STILL over budget on its own (e.g. a run-on line with no punctuation), re-split just that piece by word.

This found a real, separate discovery while testing: the "oversized block" in our actual test pdf turned out to be the References section (dense citation text), which confuses the simple sentence splitter (lots of internal periods from "et al.", abbreviated venue names). Known limitation of the simple heuristic, not a bug, the splitter still produces something reasonable, just not always grammatically clean "sentences".

### Overlap (context loss at forced splits)

Question that came up: if a paragraph gets forcibly split into two chunks, the second piece can start mid thought ("This resulted in a 15% improvement...") with no idea what "This" refers to, since the sentence that explains it is stuck in the previous piece. Hurts both the embedding (incomplete semantic unit) and generation (LLM sees a dangling reference if only that piece gets retrieved).

Important scoping point: this only matters at FORCED splits (inside splitOversizedBlock), not at every normal chunk boundary in groupIntoChunks. Normal chunks break between whole blocks/paragraphs, which are already legitimate author intended breaks, paragraph N+1 was never relying on paragraph N's sentence structure. The context loss problem is specifically an artifact of slicing something the author intended to be one continuous unit.

Fix: in packUnitsIntoPieces, when flushing a piece, carry the LAST unit of the piece just flushed forward as the seed of the next piece, instead of starting the new buffer completely empty. Learned while implementing this: since the overflow check already requires buffer.length > 0 to trigger a flush, `lastUnit` is basically always truthy in practice (the "start empty" branch of the ternary is dead code for the type checker's benefit only). Also means: once overlap is added, the buffer never resets to TRULY empty again after the first flush, it always keeps at least that one carried over unit. Thats not a bug, thats literally what overlap means, cant have shared context between pieces while also resetting to zero every time.

Known tradeoff accepted: this can occasionally make the seeded buffer (lastUnit + next unit) already slightly over budget before anything else gets added, since it doesnt get rechecked until the FOLLOWING iteration. Self corrects fast though (the next check sees the already-over total and flushes almost immediately), bounded to roughly one sentence's worth of overshoot, not a real problem.

### Token drift (separator tokens not counted)

Found via testing: some "normal" (non oversized) chunks were still coming out slightly over budget (506, 514 tokens when target was 500). Cause: bufferTokenCount was built by summing each block's OWN text tokens in isolation, but the final content joins blocks together with `\n\n` separators, and those separator characters get tokenized too. The decision was being made with a slightly smaller number than what the actual final string would contain.

Fix: computed SEPARATOR_TOKEN_COUNT once (same reasoning as the encoder, the separator string never changes so no reason to recompute its cost every time). Separator only applies BETWEEN blocks, so cost is 0 if buffer is currently empty, else the fixed separator cost. Used in two places: the overflow check (before any flush, to decide if adding this block would overflow) and the running total update (after the possible flush, to keep bufferTokenCount accurate going forward).

Subtle bit that tripped me up while explaining it: the separator cost has to be computed TWICE, once before the flush check and once after, because a flush in between can change whether buffer is empty. Reusing the pre-flush value after a flush just happened would be wrong (would think a separator is needed for the first block of a brand new chunk, when it isnt). Not redundant duplication, its checking two different points in time.

### Bug found while writing chunk.test.ts: chunks could span pages

While setting up hand crafted Block fixtures for the test, checked a simple case first: two small blocks, page 1 and page 2, both way under the token budget. Expected 2 chunks (one per page), actually got 1. groupIntoChunks had no check for page changes at all, only ever checked the token budget. Two blocks from different pages could get merged into one chunk if they fit together token wise, and the resulting chunk's `page` field would just silently report whichever page the FIRST block was on, dropping the fact that some of its content actually came from a different page.

This is exactly the same design decision made (but apparently never actually implemented) back in the very first chunking guide: chunks table has one page_number column per row, so a chunk cant honestly represent content from two pages.

Fix: added a `pageChanged` check (`buffer.length > 0 && buffer[last].page !== block.page`) that forces a flush regardless of whether the token budget would otherwise allow combining, same shape as the existing overflow check, just OR'd together (`(pageChanged || overflowsBudget) && buffer.length > 0`).

Lesson: this is a good example of why the "write the test first" instinct matters, found this by literally trying to construct a simple fixture for a different test, not by carefully auditing the code. Good reminder to actually try edge cases by hand instead of assuming a decision made in a discussion actually made it into the code.

### Testing

Wrote chunk.test.ts. Covers: small same page blocks combine into one chunk, a page change forces a new chunk even when tokens would allow combining (the regression test for the bug above), no chunk exceeds MAX_CHUNK_TOKENS even when a source block does, chunkIndex stays sequential across a mix of normal and oversized chunks, and an end to end check against the real fixture pdf (layoutText -> groupIntoChunks) confirming every real chunk respects the budget. Exported MAX_CHUNK_TOKENS from chunk.ts so the test references the real constant instead of duplicating the number 500 separately.

Used a `makeBlock()` helper in the test file to build fake Block objects without touching a real PDF, this is the actual payoff of the earlier decision to keep groupIntoChunks decoupled from layoutText, wouldnt have been possible to test the page boundary bug this cleanly (or at all, easily) if chunk.ts had been coupled to calling layoutText itself.

All 11 tests across the three files (extract, layout, chunk) pass after this.

---

## Switching off paid APIs: local embeddings + Ollama (instead of Voyage + Claude)

Decided not to pay for API usage since this is a learning/portfolio project, not something that needs production quality. Going fully local instead: Ollama for generation (not built yet, waiting on Ollama install), a local embedding model for embeddings (done). Tradeoff accepted on purpose: quality drops vs Voyage/Claude, but zero ongoing cost and no API key needed. Documented as a "future upgrade path" rather than a permanent decision, since swapping back to Voyage/Claude later is just swapping these two modules again.

Also worth remembering the actual distinction that started this: a Claude.ai Pro/Max subscription and the Claude API are completely separate billing systems. Having a personal subscription doesnt give free API usage. The API is metered pay-per-token, billed to whoever's API key is in `.env`, separate from any chat subscription.

### Embeddings: Voyage -> local model (done)

Swapped `embeddings.ts` from calling Voyage's hosted API to running a model locally via `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`), entirely inside the Node process, no network call, no API key.

Real gotcha found immediately: Voyage's `voyage-3` outputs 1024-dim vectors, which is why the `chunks` table schema had `embedding VECTOR(1024)` from the very first migration. MiniLM outputs 384-dim vectors instead. Swapping the embedding model changes the vector dimension, which means the DB column has to change too, or every insert would fail with a dimension mismatch. Added `003_alter_embedding_dim.sql`: `ALTER TABLE chunks ALTER COLUMN embedding TYPE VECTOR(384)`, plus had to drop and recreate the HNSW index since it's built for a specific dimension and doesnt auto-rebuild when the column type changes.

Kept the `embed(texts, inputType)` function signature the same as before (`inputType: 'document' | 'query'`) even though the local model has no separate query/document mode and ignores that parameter now — did this so nothing calling `embed()` later needs to know or care which embedding backend is behind it.

Verified: ran the migration, confirmed via `pg_attribute` that the column is actually `vector(384)` now, and ran the embed function against a real string, got back a 384-length array of numbers. No cost, no API key needed for any of this.

### Generation: Claude -> Ollama (done)

Ollama is a separate desktop app (not an npm package) that runs open models locally and exposes a local HTTP API on `localhost:11434`. Installed it, pulled `llama3.2` (3.2B params, ~2GB) via `ollama pull llama3.2`.

Roadblock: right after installing, `ollama` wasn't recognized in the already-open terminal (`command not found`). Not a real problem, just PATH not being picked up by a shell that was already open before the installer ran — confirmed the app itself was actually running and reachable by hitting `http://localhost:11434` directly and by calling the exe via its full install path (`C:\Users\sofia\AppData\Local\Programs\Ollama\ollama.exe`) instead of waiting on PATH.

Wrote `server/src/lib/generation.ts`, mirroring `embeddings.ts`'s role: one exported function, `chat(messages)`, calling Ollama's `/api/chat` endpoint. Deliberately used the chat endpoint (`{role, content}[]` messages) instead of the simpler `/api/generate` (single flat prompt string) — chat shape is what the eventual RAG generation step actually needs (a system prompt plus a user question), same reasoning as keeping `embed()`'s document/query distinction even after swapping the backend.

Verified end to end: hit `/api/generate` directly with curl first to confirm the model responds at all, then wrote and ran `chat()` against a real question ("what is the capital of France") and got back a real, correct answer through the actual module, not just the raw API.

---

## embed.ts (server/src/lib/pdf/embed.ts) — the actual embedding step of ingestion

This is separate from swapping embeddings.ts to a local model (that was just the raw tool). This is the actual pipeline step: take Chunk[] from chunk.ts, produce EmbeddedChunk[] (Chunk & { embedding: number[] }), ready to persist.

### EmbeddedChunk type and why embedding is number[], not a single number

An embedding IS an array of numbers, not one number. Our local model outputs 384 dimensional vectors, so one embedding is 384 floats together, representing one point in 384 dimensional space. "One vector per chunk" and "that vector is an array of 384 numbers" are the same fact, not two different things. `EmbeddedChunk = Chunk & { embedding: number[] }`, same "extend the previous stage's type" pattern as Chunk extending from Block info.

### Batching, again, but for a different reason than chunk.ts's batching

chunk.ts batches (packs blocks into token budgets) because of embedding model input limits. This is different: `embed()` accepts an array of texts and processes them together, calling it once per chunk in a loop instead of once per BATCH of chunks throws away that throughput benefit for no reason, especially now that its free/local (still worth doing efficiently, just not for cost/rate-limit reasons anymore). Grouped chunks into batches of 32 (BATCH_SIZE), one `embed()` call per batch instead of per chunk.

Loop shape: `for (let i = 0; i < chunks.length; i += BATCH_SIZE)`, slicing `chunks.slice(i, i + BATCH_SIZE)` each time. `.slice()` handles the boundary case for free, no special code needed: asking for a range past the array's actual end just silently returns fewer elements than requested (not an error, not padded with undefined). So the very last batch is naturally whatever's left over (e.g. 8 chunks if total was 40 and BATCH_SIZE is 32), same code path as every other batch.

### First attempt used `export default`

Caught this because literally nothing else in this whole project uses a default export, only named exports (`extractTextRuns`, `layoutText`, `groupIntoChunks`, `countTokens`, all named). Would have made this the one inconsistent import in the whole codebase (`import embedChunks from` instead of `import { embedChunks } from`). Fixed to a named export.

### Verifying ordering: a red herring at first

Tested whether `embeddings[j]` really lines up with `batch[j]` (matching vectors back to the right chunk by array position). First test compared a chunk's embedding (produced inside a 3-item batch) against the SAME text embedded completely alone (a 1-item batch), got distance 0.13, not 0. Looked like a bug at first. Turned out to just be harmless batching noise: different batch compositions can produce tiny floating point differences internally (padding-related), nothing to do with ordering being wrong. Re-tested comparing against the SAME batch composition (3 words embedded together, compared against that same 3-item batch's output) and got distance exactly 0, confirming ordering is correct. Lesson: isolate one variable at a time when a test result looks surprising, don't assume the first explanation (bug) over a simpler one (test design difference) without checking.

Also confirmed the multi-batch boundary for real (not just reasoned about): ran embedChunks against 40 fake chunks (forces a 32 + 8 split), got 40 back, correct order, correct dims. This was worth doing specifically because the real test PDF only ever produces ~22 chunks, under BATCH_SIZE, so every real run so far had only ever gone through ONE batch — the multi-batch path had literally never executed until this check.

### Testing

Wrote embed.test.ts: well formed output (right count, right dims, real numbers not NaN), original chunk fields preserved alongside the new embedding field, ordering preserved in a single batch, ordering AND count preserved across the batch boundary (the 40-chunk case made permanent instead of a scratch script), and a sanity check that two genuinely different sentences don't produce near identical vectors (catches a degenerate "always returns the same thing" failure mode). Since this is local/free now, tests call the real model directly, no mocking needed, unlike what we'd have had to do for a paid API.

All 16 tests across extract/layout/chunk/embed pass together.

---

## Persistence phase (starting)

Goal: take a document_id + EmbeddedChunk[], write real rows into `documents` and `chunks`.

### What "the document" row actually is

Metadata ABOUT the uploaded file, not the file itself and not its content. From the original schema: id (UUID, db generated), title, filename, mime_type, metadata (JSONB, empty by default), uploaded_at. Chunk text lives in `chunks`, not here.

Real gap noticed while going through this: nothing in the current schema stores the actual original PDF bytes anywhere (no file path, no blob column, no S3 reference). Only extracted/chunked text ends up persisted. The readme promises clicking a citation opens "the highlighted source in the original PDF" — that needs the original file to still exist somewhere later, which currently it doesn't. Logged as an open item, not solved yet.

### Why we need Documents AND Chunks, not just Chunks

`chunks.document_id` is a real foreign key: `REFERENCES documents(id) ON DELETE CASCADE`. Postgres will flatly reject inserting a chunk whose document_id doesn't already exist as a real row in `documents`. So order matters: create the document row first (get back its generated id via `RETURNING id`), only then insert chunks using that id. Can't skip straight to chunks, thered be nothing valid to attach them to.

### Why Documents/Chunks helpers are separate from the existing Jobs helper

Jobs (already built, way earlier) tracks ingestion PROCESSING STATUS (pending/parsing/embedding/done/failed) for a document, scoped only to the `jobs` table, knows nothing about documents or chunks tables. Documents/Chunks will track actual CONTENT, each scoped to their own table, same one-helper-per-table pattern. All three share the same `pool` connection but never reach into each other's territory.

### DocumentRow / ChunkRow types — separate from the pipeline's own Chunk type

Same reason Job already exists as its own type: describes what a row ACTUALLY looks like coming back from a query, not the in-memory shape used elsewhere. Two real reasons this has to be a separate type from chunk.ts's `Chunk`, not just reused:

1. Naming convention: real DB columns are snake_case (chunk_index, page_number, char_start, char_end, document_id, created_at) since `pg` returns whatever the actual SQL column names are, no auto camelCase conversion. `Chunk` (the pipeline type) is deliberately camelCase, matching the rest of this codebase's TS convention. Two different naming conventions for two different representations.
2. Field mismatch: a real chunk row also has `id`, `document_id`, `created_at`, none of which the pipeline's `Chunk`/`EmbeddedChunk` ever carries, since those are either db-generated or only attached at persistence time.

Named the new type `ChunkRow` (not `Chunk`) specifically to avoid clashing with the existing import. Also noted: pgvector's VECTOR column comes back from `pg` as a raw text string (like `"[0.1,0.2,...]"`), not a parsed number[] — `pg` has no built in understanding of the vector type, same gotcha applies going the other way when INSERTing (have to format a number[] into that bracketed string format ourselves before it can go into a query parameter).

Added `DocumentRow` and `ChunkRow` to db.ts, next to the existing `Job` type. Just the types for now, not the actual Documents/Chunks query helpers yet.

### Learning note: what a TS type is actually for (JS learning aside)

Came up while defining these types: a type doesn't make data extraction happen, plain JS + `pg` + SQL already does that regardless of any type annotation. TypeScript types are erased completely at compile time — the actual running JS never sees them. What a type actually buys you: the compiler/editor can check your code against the expected shape BEFORE running it (autocomplete, catching a typo'd field name immediately) instead of finding out at runtime via a silent `undefined` or a crash later on. `pool.query<ChunkRow>(...)` vs `pool.query(...)` returns the exact same real data either way, the difference is entirely about whether mistakes get caught early or late.

### Documents and Chunks helpers written

`Documents`: `create` (INSERT ... RETURNING *), `getById`, `getAll`. Straightforward, mirrors `Jobs`'s existing shape.

`Chunks`: `getByDocumentId` (ordered by chunk_index), `getById`, `getByDocumentIdAndIndex`, plus the important one, `insertMany`.

First draft of the insert was a single-row `create`, same shape as `Documents.create`. Changed to bulk `insertMany` on purpose, matching the persistence-phase plan from before: one multi-row INSERT for a whole document's chunks instead of one INSERT call per chunk in a loop, same throughput reasoning as batching `embed()` calls. Also wrapped in a real transaction (`BEGIN`/`COMMIT`/`ROLLBACK`) so a failure partway through rolls back the whole batch instead of leaving a half-inserted document — this needed its own checked-out client via `pool.connect()` rather than the shared `pool.query()`, since a transaction needs every statement on the same connection and the pool doesn't guarantee that otherwise. Always `client.release()` in a `finally`, success or failure, or the connection never goes back to the pool.

Kept `Chunks.insertMany`'s input type (`NewChunk`) separate from the pipeline's `EmbeddedChunk` on purpose — db.ts stays decoupled from the pdf/ folder, same as every other module boundary in this project. Whatever eventually orchestrates persistence is responsible for mapping an `EmbeddedChunk` into this shape (including formatting the embedding into pgvector's text format), not db.ts.

### Verified end to end against the real database

Ran a real test: created a document, bulk-inserted 2 chunks, fetched them back, deleted the document (cascade deleted its chunks too, confirmed by the schema's `ON DELETE CASCADE`).

First attempt used a fake 3-number placeholder vector (`[0.1,0.2,0.3]`) just to have something to pass — pgvector correctly rejected it: `expected 384 dimensions, not 3`. Not a bug, the opposite: confirms pgvector actually enforces the column's declared dimension at insert time, catching a bad vector before it ever gets stored. Real mistake in the test script though: it crashed before reaching its own cleanup step, leaving an orphaned `documents` row behind in the real database. Had to manually delete it afterward. Lesson: a test script's cleanup step has to be safe against the test itself failing (e.g. cleanup in a `finally`, or catch-and-cleanup-then-rethrow), otherwise a failing test is exactly the case most likely to skip its own teardown and leave real garbage behind — the one time you actually need cleanup to run is the time an unguarded script won't run it.

Fixed the test with a real 384-number fake vector and reran — document created, both chunks inserted in one transaction, fetched back correctly, cleaned up successfully this time.

Still missing before this is really "done": the actual `number[] -> "[0.1,0.2,...]"` conversion function doesn't exist as real code yet (the test inlined one by hand for the fake vector); and there's still no orchestrator function that takes real `EmbeddedChunk[]` from `embed.ts`, converts each one into `NewChunk` shape, and calls `Documents.create` + `Chunks.insertMany` for real. Also no permanent test file yet for any of this (`db.test.ts` or similar) — everything verified so far is a scratch script again, same situation `chunk.ts` and `embed.ts` were in before their tests were written.

---

### EmbeddedChunk to NewChunk persistence mapper

Added `server/src/lib/pdf/persist.ts`. This is the real runtime conversion that the `NewChunk` type alone could never perform. `formatEmbeddingForPgvector` converts the local model's `number[]` vector into pgvector's bracketed text format. For example, `[0.1, -0.2]` becomes `"[0.1,-0.2]"`. `toNewChunks` maps each EmbeddedChunk field into the database-ready NewChunk shape, including `page -> pageNumber`. `persistEmbeddedChunks` connects that mapper directly to `Chunks.insertMany(documentId, ...)`, so callers can persist real EmbeddedChunk[] without manually formatting every vector.

Exported `EmbeddedChunk` from embed.ts and `NewChunk` from db.ts so this boundary can be type checked cleanly without making db.ts import the PDF pipeline. Wrote `persist.test.ts` covering vector formatting, field mapping, and proving that mapping does not mutate the original EmbeddedChunk objects.

Roadblock while verifying: the full test suite failed once when PDF test files ran concurrently and `pdfjs-dist` initialized in one process without its optional canvas polyfill (`DOMMatrix is not defined`). The mapper tests themselves were green. Running the complete suite sequentially passed 19/19, proving this was test concurrency and not an ingestion regression. Updated the npm test script to use `--test-concurrency=1` so the default suite is deterministic on this Windows setup.

Still missing before persistence is fully done: the complete document-level orchestrator that creates the document row, runs layout/chunk/embed, calls persistEmbeddedChunks, and coordinates job status. There is also no permanent integration test for the real Documents/Chunks database helpers yet; persist.test.ts tests the conversion boundary without requiring Docker/Postgres.

---

## Open items / not done yet

- MAX_CHUNK_TOKENS = 500 is a guess, not measured. Once the readme's eval harness (recall@k, MRR) exists, should actually test different values against real retrieval quality instead of assuming 500 is right. Revisit this later, not now.
- No overlap between NORMAL chunk boundaries (between different blocks), only inside splitOversizedBlock. Decided on purpose, paragraph boundaries are real breaks, not worth the complexity there.
- char offsets inside splitOversizedBlock are approximate (rejoining sentences/words with a single space doesnt preserve original whitespace exactly, and now overlap means consecutive pieces share text too), not pixel exact against the source pdf. Acceptable for now.
- The actual "call layoutText, then groupIntoChunks, then embed, then persist" orchestration doesnt exist anywhere yet. That's the ingestion worker, not built. Needs the `jobs` table (already migrated) wired up to a real background process.
- generation.ts has no error handling yet for Ollama not running / model not pulled beyond a generic thrown error on a bad response. Fine for now, worth revisiting once this is wired into a real request path.
- If ever revisited: swap local embeddings back to Voyage and local generation back to Claude for a "production mode", since the rest of the pipeline (chunking, schema) barely needs to change either way.
- No storage anywhere for the original uploaded PDF file/bytes. Needed for the "click citation, open highlighted source PDF" feature from the readme. Not solved yet, needs a decision (filesystem path? object storage like S3? a column on documents?).
- No complete document-level orchestrator yet tying Documents.create -> layoutText -> groupIntoChunks -> embedChunks -> persistEmbeddedChunks together into one real ingestion function.
- No permanent test file for the Documents/Chunks db helpers yet (everything verified via scratch scripts so far). Still need to decide the testing strategy too: real inserts + manual cleanup, vs wrapping each test in a transaction that gets rolled back at the end. Leaning rollback, not decided.
