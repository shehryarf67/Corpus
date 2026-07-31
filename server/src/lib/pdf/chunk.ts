// Chunks allow us to take inconsistently sized blocks and package them into consistent chunks
// that fit a particular token size. This allows avoidance of unnecessary embedding and wastage of
// vector space.

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

export function countTokens(text: string): number {
  return encoder.encode(text).length;
}

