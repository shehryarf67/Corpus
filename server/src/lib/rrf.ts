import type { KeywordRetrievedChunk, RetrievedChunk } from './db.js'

const RRF_K = 60

// RRF produces a third representation because raw cosine similarity and
// Postgres keyword scores use unrelated scales. Positions and the fused score
// are kept for debugging and later retrieval evaluations.
export type FusedChunk = {
  id: string
  document_id: string
  chunk_index: number
  content: string
  page_number: number | null
  char_start: number
  char_end: number
  similarity: number | null
  keywordScore: number | null
  vectorPosition: number | null
  keywordPosition: number | null
  rrfScore: number
}

function initializedFusedChunk(
  chunk: RetrievedChunk | KeywordRetrievedChunk
): FusedChunk {
  return {
    id: chunk.id,
    document_id: chunk.document_id,
    chunk_index: chunk.chunk_index,
    content: chunk.content,
    page_number: chunk.page_number,
    char_start: chunk.char_start,
    char_end: chunk.char_end,
    similarity: null,
    keywordScore: null,
    vectorPosition: null,
    keywordPosition: null,
    rrfScore: 0,
  }
}

export function fuseWithRRF(
  vectorResults: readonly RetrievedChunk[],
  keywordResults: readonly KeywordRetrievedChunk[]
): FusedChunk[] {
  const fusedById = new Map<string, FusedChunk>()

  vectorResults.forEach((chunk, index) => {
    const position = index + 1
    const fused = fusedById.get(chunk.id) ?? initializedFusedChunk(chunk)

    fused.similarity = chunk.similarity
    fused.vectorPosition = position
    fused.rrfScore += 1 / (RRF_K + position)
    fusedById.set(chunk.id, fused)
  })

  keywordResults.forEach((chunk, index) => {
    const position = index + 1
    const fused = fusedById.get(chunk.id) ?? initializedFusedChunk(chunk)

    fused.keywordScore = chunk.keyword_score
    fused.keywordPosition = position
    fused.rrfScore += 1 / (RRF_K + position)
    fusedById.set(chunk.id, fused)
  })

  return [...fusedById.values()].sort((a, b) => {
    const scoreDifference = b.rrfScore - a.rrfScore
    if (scoreDifference !== 0) return scoreDifference

    // Deterministic tie-breakers make repeated tests and responses stable.
    const bestA = Math.min(
      a.vectorPosition ?? Number.POSITIVE_INFINITY,
      a.keywordPosition ?? Number.POSITIVE_INFINITY
    )
    const bestB = Math.min(
      b.vectorPosition ?? Number.POSITIVE_INFINITY,
      b.keywordPosition ?? Number.POSITIVE_INFINITY
    )
    return bestA - bestB || a.chunk_index - b.chunk_index
  })
}
