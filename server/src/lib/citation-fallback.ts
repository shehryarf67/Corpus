import {
  answerClaims,
  claimsByLabel,
  lexicalAttributionForClaim,
} from './citation-passages.js'
import type { ContextSource } from './context.js'
import {
  scorePassagePairs,
  type PassagePair,
} from './reranker.js'

const CROSS_ENCODER_MIN_SCORE = 1
const CROSS_ENCODER_MIN_MARGIN = 0.75

export type CrossEncoderChoice = {
  sourceIndex: number
  score: number
}

/** Reject a weak or ambiguous winner instead of returning the least-bad chunk. */
export function selectCrossEncoderChoice(
  scores: readonly number[],
  minimumScore = CROSS_ENCODER_MIN_SCORE,
  minimumMargin = CROSS_ENCODER_MIN_MARGIN
): CrossEncoderChoice | null {
  const ranked = scores
    .map((score, sourceIndex) => ({ score, sourceIndex }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex)

  const best = ranked[0]
  if (!best || best.score < minimumScore) return null

  const runnerUp = ranked[1]
  if (runnerUp && best.score - runnerUp.score < minimumMargin) return null
  return best
}

type PairScorer = (pairs: readonly PassagePair[]) => Promise<number[]>

/** Verify valid-looking model labels against their actual supporting chunks. */
export async function selectCitationPassagesWithFallback(
  answer: string,
  citedSources: readonly ContextSource[],
  candidateSources: readonly ContextSource[],
  scorePairs: PairScorer = scorePassagePairs
): Promise<ContextSource[]> {
  const claims = claimsByLabel(answer)
  const resolved: Array<ContextSource | null> = Array(citedSources.length).fill(null)
  const unmatched: Array<{
    citedSource: ContextSource
    citedIndex: number
    claim: string
  }> = []

  for (const [citedIndex, citedSource] of citedSources.entries()) {
    const sourceClaims = claims.get(citedSource.label.toUpperCase()) ?? []
    let lexicalBest: ReturnType<typeof lexicalAttributionForClaim> = null

    for (const claim of sourceClaims) {
      const match = lexicalAttributionForClaim(claim, candidateSources)
      if (match && (!lexicalBest || match.score > lexicalBest.score)) {
        lexicalBest = match
      }
    }

    if (lexicalBest) {
      resolved[citedIndex] = {
        ...lexicalBest.source,
        label: citedSource.label,
        highlightText: lexicalBest.passage,
      }
      continue
    }

    if (sourceClaims.length > 0) {
      unmatched.push({
        citedSource,
        citedIndex,
        claim: sourceClaims.join(' '),
      })
    }
  }

  const pairs = unmatched.flatMap(({ claim }) =>
    candidateSources.map((source) => ({ query: claim, passage: source.content }))
  )
  const scores = await scorePairs(pairs)
  if (scores.length !== pairs.length) {
    throw new Error(
      `Cross-encoder returned ${scores.length} scores for ${pairs.length} citation pairs`
    )
  }

  unmatched.forEach(({ citedSource, citedIndex }, unmatchedIndex) => {
    const offset = unmatchedIndex * candidateSources.length
    const choice = selectCrossEncoderChoice(
      scores.slice(offset, offset + candidateSources.length)
    )
    const source = choice ? candidateSources[choice.sourceIndex] : undefined
    if (!source) return

    resolved[citedIndex] = {
      ...source,
      label: citedSource.label,
      // The semantic score verifies a chunk, but cannot safely select PDF text.
      highlightText: null,
    }
  })

  // A label with neither lexical nor strong semantic support gets no source
  // chip. This is safer than trusting valid-looking syntax or a weak winner.
  return resolved.filter((source): source is ContextSource => source !== null)
}

/**
 * Attribute answer claims locally. Lexical matching stays first because it can
 * return an exact highlight; the cross-encoder handles only paraphrased misses.
 */
export async function attributeAnswerSourcesWithFallback(
  answer: string,
  candidateSources: readonly ContextSource[],
  scorePairs: PairScorer = scorePassagePairs
): Promise<ContextSource[]> {
  const claims = answerClaims(answer)
  const attributed = new Map<
    string,
    { source: ContextSource; highlightText: string | null; order: number }
  >()
  const unmatched: Array<{ claim: string; order: number }> = []

  for (const [order, claim] of claims.entries()) {
    const lexical = lexicalAttributionForClaim(claim, candidateSources)
    if (!lexical) {
      unmatched.push({ claim, order })
      continue
    }

    if (!attributed.has(lexical.source.chunkId)) {
      attributed.set(lexical.source.chunkId, {
        source: lexical.source,
        highlightText: lexical.passage,
        order,
      })
    }
  }

  const pairs = unmatched.flatMap(({ claim }) =>
    candidateSources.map((source) => ({ query: claim, passage: source.content }))
  )
  const scores = await scorePairs(pairs)
  if (scores.length !== pairs.length) {
    throw new Error(
      `Cross-encoder returned ${scores.length} scores for ${pairs.length} citation pairs`
    )
  }

  unmatched.forEach(({ order }, unmatchedIndex) => {
    const offset = unmatchedIndex * candidateSources.length
    const choice = selectCrossEncoderChoice(
      scores.slice(offset, offset + candidateSources.length)
    )
    if (!choice) return

    const source = candidateSources[choice.sourceIndex]
    if (!source || attributed.has(source.chunkId)) return

    attributed.set(source.chunkId, {
      source,
      // Semantic fallback identifies the chunk, not an exact span. Page-only
      // navigation is safer than highlighting guessed words.
      highlightText: null,
      order,
    })
  })

  return [...attributed.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ source, highlightText }) => ({ ...source, highlightText }))
}
