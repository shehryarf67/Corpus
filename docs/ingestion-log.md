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

## Open items / not done yet

- MAX_CHUNK_TOKENS = 500 is a guess, not measured. Once the readme's eval harness (recall@k, MRR) exists, should actually test different values against real retrieval quality instead of assuming 500 is right. Revisit this later, not now.
- No overlap between NORMAL chunk boundaries (between different blocks), only inside splitOversizedBlock. Decided on purpose, paragraph boundaries are real breaks, not worth the complexity there.
- char offsets inside splitOversizedBlock are approximate (rejoining sentences/words with a single space doesnt preserve original whitespace exactly, and now overlap means consecutive pieces share text too), not pixel exact against the source pdf. Acceptable for now.
- The actual "call layoutText, then groupIntoChunks, then embed, then persist" orchestration doesnt exist anywhere yet. That's the ingestion worker, not built. Needs the `jobs` table (already migrated) wired up to a real background process.
- Embedding step itself (calling voyageai) not started.
