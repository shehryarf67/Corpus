// Chunks allow us to take inconsistently sized blocks and package them into consistent chunks
// that fit a particular token size. This allows avoidance of unnecessary embedding and wastage of
// vector space.
import type { Block } from "./layout.js"
import { get_encoding } from "tiktoken";

// Created once, at module load, and reused for every countTokens call.
// get_encoding() parses the BPE merge-rank tables, which isn't cheap —
// doing that on every call (and freeing right after) would mean paying
// that setup cost repeatedly during a single document's chunking pass,
// which calls this far more than once. Since this encoder is meant to
// live for the process's lifetime, it's intentionally never freed here —
// there's no natural point in a long-running server process where "we're
// done with it" happens.
const encoder = get_encoding("cl100k_base");

export const MAX_CHUNK_TOKENS = 500

export function countTokens(text: string): number {
  return encoder.encode(text).length;
}

// The separator joined between blocks' text when building a chunk's final
// content (see flushBuffer below). Its own tokens weren't being counted
// during accumulation — only each block's text in isolation — so a chunk's
// real token count could end up slightly higher than the running total
// used to decide when to flush. Computed once since the string never
// changes, same reasoning as the encoder singleton above.
const CHUNK_SEPARATOR = '\n\n'
const SEPARATOR_TOKEN_COUNT = countTokens(CHUNK_SEPARATOR)

type Chunk = {
  content: string
  page: number
  charStart: number
  charEnd: number
  chunkIndex: number
}

// Splits text at sentence boundaries. The lookbehind `(?<=[.?!])` matches
// the position right after a period/question mark/exclamation point
// without consuming it, so the punctuation stays attached to the sentence
// it ends, and `\s+` (the whitespace after it) is what actually gets
// removed as the split point.
function splitIntoSentences(text: string): string[] {
  return text.split(/(?<=[.?!])\s+/).filter((sentence) => sentence.length > 0)
}

// Only used as a last resort, for the rare case where a single "sentence"
// (by the simple rule above) is still too big on its own — e.g. a long
// run-on line with no punctuation at all.
function splitIntoWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0)
}

// Packs an array of small text units (sentences, or words as a fallback)
// into token-budget-respecting pieces. Same accumulate-until-budget-then-
// flush shape as groupIntoChunks itself — just operating on units of text
// instead of units of Block.
function packUnitsIntoPieces(units: string[]): string[] {
  const pieces: string[] = []
  let buffer: string[] = []
  let bufferTokenCount = 0

  for (const unit of units) {
    const tokenCount = countTokens(unit)

    if (bufferTokenCount + tokenCount > MAX_CHUNK_TOKENS && buffer.length > 0) {
      pieces.push(buffer.join(' '))

      // Carry the last unit of the piece just flushed into the next one,
      // instead of starting completely empty. A piece that begins
      // mid-thought (e.g. "This resulted in...") still has the sentence
      // it depends on for context, rather than losing it to the split.
      const lastUnit = buffer[buffer.length - 1] ?? ''
      buffer = lastUnit ? [lastUnit] : []
      bufferTokenCount = lastUnit ? countTokens(lastUnit) : 0
    }

    buffer.push(unit)
    bufferTokenCount += tokenCount
  }

  if (buffer.length > 0) {
    pieces.push(buffer.join(' '))
  }

  return pieces
}

// A single block whose own text already exceeds the token budget can't
// become one chunk without splitting the text itself. Break it into
// sentences first (a natural boundary), and only fall back to splitting
// by word if a single sentence is still oversized on its own.
function splitOversizedBlock(block: Block, startingChunkIndex: number): Chunk[] {
  let pieces = packUnitsIntoPieces(splitIntoSentences(block.text))

  // Rare case: one sentence, by itself, is still over budget. Re-split
  // just that piece by word instead of leaving it oversized.
  pieces = pieces.flatMap((piece) =>
    countTokens(piece) > MAX_CHUNK_TOKENS ? packUnitsIntoPieces(splitIntoWords(piece)) : [piece]
  )

  const chunks: Chunk[] = []
  // Approximate, for two reasons: the original whitespace between
  // sentences/words isn't preserved exactly once rejoined with a single
  // space, and consecutive pieces now share an overlapping sentence — so
  // these offsets land close to, but not pixel-exact with, the source PDF.
  let charOffset = block.charStart

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] ?? ''
    const charStart = charOffset
    const charEnd = charStart + piece.length

    chunks.push({
      content: piece,
      page: block.page,
      charStart,
      charEnd,
      chunkIndex: startingChunkIndex + i,
    })

    charOffset = charEnd + 1
  }

  return chunks
}

export function groupIntoChunks(blocks: Block[]): Chunk[] {
    const chunks: Chunk[] = []

    // The blocks accumulated for the chunk currently being built, and a
    // running total of their combined token count — tracked separately
    // rather than recomputed from `buffer` each time, same idea as
    // `current.fontSize` being tracked incrementally in groupIntoLines.
    let buffer: Block[] = []
    let bufferTokenCount = 0
    let chunkIndex = 0

    const flushBuffer = () => {
        if (buffer.length === 0) return

        const first = buffer[0]
        const last = buffer[buffer.length - 1]
        // buffer.length > 0 guarantees these exist; the checks are only
        // here to satisfy noUncheckedIndexedAccess.
        if (!first || !last) return

        chunks.push({
            content: buffer.map((block) => block.text).join(CHUNK_SEPARATOR),
            page: first.page,
            charStart: first.charStart,
            charEnd: last.charEnd,
            chunkIndex,
        })

        chunkIndex++
        buffer = []
        bufferTokenCount = 0
    }

    for (const block of blocks) {
        const tokenCount = countTokens(block.text)

        // This one block's own text already exceeds the budget — close
        // off whatever's buffered so far (it shouldn't get merged with
        // this block), split this block into several smaller chunks on
        // its own, and move on without adding it to the normal buffer.
        if (tokenCount > MAX_CHUNK_TOKENS) {
            flushBuffer()
            const oversizedChunks = splitOversizedBlock(block, chunkIndex)
            chunks.push(...oversizedChunks)
            chunkIndex += oversizedChunks.length
            continue
        }

        // A separator only appears *between* blocks — an empty buffer's
        // first block doesn't cost one. Checked here, before any flush,
        // to decide whether adding this block would overflow.
        const separatorCostBeforeFlush = buffer.length > 0 ? SEPARATOR_TOKEN_COUNT : 0

        // A chunk can't span pages — the `chunks` table has one page_number
        // column per row, same reasoning as blocks not spanning pages in
        // layout.ts. A page change forces a flush regardless of whether the
        // token budget would otherwise allow adding this block.
        const pageChanged = buffer.length > 0 && buffer[buffer.length - 1]?.page !== block.page

        // Would adding this block (plus its separator, if any) push the
        // running total past the budget? Note this compares against
        // bufferTokenCount (tokens already accumulated), not buffer.length
        // (block count) — those are different units entirely. `buffer.length
        // > 0` guards against flushing an already-empty buffer, which can't
        // happen here since the oversized case above already handled that
        // possibility.
        const overflowsBudget = bufferTokenCount + separatorCostBeforeFlush + tokenCount > MAX_CHUNK_TOKENS
        if ((pageChanged || overflowsBudget) && buffer.length > 0) {
            flushBuffer()
        }

        // Re-checked rather than reusing separatorCostBeforeFlush — a flush
        // may have just emptied the buffer, in which case this block is now
        // the first one in a fresh buffer and doesn't cost a separator.
        const separatorCost = buffer.length > 0 ? SEPARATOR_TOKEN_COUNT : 0
        buffer.push(block)
        bufferTokenCount += tokenCount + separatorCost
    }

    // Same as every other accumulator in this pipeline: the loop only
    // flushes when the *next* block overflows, so whatever's left in the
    // buffer after the last block needs a manual flush here.
    flushBuffer()

    return chunks
}