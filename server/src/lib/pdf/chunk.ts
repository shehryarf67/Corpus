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

const MAX_CHUNK_TOKENS  = 500

export function countTokens(text: string): number {
  return encoder.encode(text).length;
}

type Chunk = {
  content: string
  page: number
  charStart: number
  charEnd: number
  chunkIndex: number
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
            content: buffer.map((block) => block.text).join('\n\n'),
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

        // Would adding this block push the running total past the budget?
        // Note this compares against bufferTokenCount (tokens already
        // accumulated), not buffer.length (block count) — those are
        // different units entirely. `buffer.length > 0` guards against
        // flushing an already-empty buffer when a single block alone
        // exceeds the budget (that oversized-block case needs its own
        // fallback later — for now it just becomes its own, still
        // oversized, chunk).
        if (bufferTokenCount + tokenCount > MAX_CHUNK_TOKENS && buffer.length > 0) {
            flushBuffer()
        }

        buffer.push(block)
        bufferTokenCount += tokenCount
    }

    // Same as every other accumulator in this pipeline: the loop only
    // flushes when the *next* block overflows, so whatever's left in the
    // buffer after the last block needs a manual flush here.
    flushBuffer()

    return chunks
}