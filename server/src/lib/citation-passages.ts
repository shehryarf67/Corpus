import type { ContextSource } from './context.js'

const CITATION_PATTERN = /\[(S\d+)\]/gi
const MIN_PASSAGE_SCORE = 0.3

const COMMON_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their',
  'this', 'to', 'was', 'were', 'which', 'with',
])

function words(text: string): string[] {
  return (text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 1 && !COMMON_WORDS.has(word))
}

export function claimsByLabel(answer: string): Map<string, string[]> {
  const claims = new Map<string, string[]>()

  // Citation prompts place labels directly after claims. Sentence-sized units
  // preserve that relationship without asking another model to parse it.
  const sentences = answer
    .replace(/\s+/g, ' ')
    .trim()
    // Do not detach a citation written after sentence punctuation, such as
    // `The result improved. [S1]`, from the claim it belongs to.
    .split(/(?<=[.!?])\s+(?!\[S\d+\])/i)
  for (const sentence of sentences) {
    const labels = Array.from(sentence.matchAll(CITATION_PATTERN)).map(
      (match) => match[1]?.toUpperCase()
    )
    const claim = sentence.replace(CITATION_PATTERN, '').trim()

    for (const label of labels) {
      if (!label || !claim) continue
      const existing = claims.get(label) ?? []
      existing.push(claim)
      claims.set(label, existing)
    }
  }

  return claims
}

export function answerClaims(answer: string): string[] {
  return answer
    .replace(CITATION_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((claim) => claim.trim())
    .filter(Boolean)
    // A refusal reports missing evidence; it must not receive a source chip
    // merely because a retrieved chunk shares generic words with it.
    .filter(
      (claim) =>
        !claim.toLocaleLowerCase().includes('could not find the answer') &&
        !claim.toLocaleLowerCase().includes('could not find any searchable content')
    )
}

function passageCandidates(content: string): string[] {
  const candidates: string[] = []
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  for (const paragraph of paragraphs) {
    const sentences = paragraph
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean)

    candidates.push(...sentences)

    // Neighbouring sentences preserve context for pronouns and short claims.
    for (let index = 0; index < sentences.length - 1; index++) {
      candidates.push(`${sentences[index]} ${sentences[index + 1]}`)
    }

    // Table rows and extracted lists often contain no sentence punctuation.
    // Keep a reasonably sized paragraph as a candidate for those cases.
    if (paragraph.length <= 800) candidates.push(paragraph)
  }

  return [...new Set(candidates)]
}

function relevanceScore(claim: string, passage: string): number {
  const claimWords = new Set(words(claim))
  const passageWords = new Set(words(passage))
  if (claimWords.size === 0 || passageWords.size === 0) return 0

  let shared = 0
  for (const word of claimWords) {
    if (passageWords.has(word)) shared += 1
  }

  // Coverage asks how much of the claim the passage explains. Precision keeps
  // a short supporting sentence ahead of a large paragraph containing the same
  // words somewhere among unrelated table or heading text.
  const coverage = shared / claimWords.size
  const precision = shared / passageWords.size
  let score = coverage * 0.75 + precision * 0.25

  const claimNumbers = [...claimWords].filter((word) => /^\d/.test(word))
  if (claimNumbers.length > 0) {
    const matchingNumbers = claimNumbers.filter((number) => passageWords.has(number))
    score += matchingNumbers.length === claimNumbers.length ? 0.15 : -0.2
  }

  return score
}

type ScoredPassage = {
  passage: string
  score: number
}

export type LexicalAttribution = {
  source: ContextSource
  passage: string
  score: number
}

function bestPassage(claims: string[], content: string): ScoredPassage | null {
  let best: { passage: string; score: number } | null = null

  for (const passage of passageCandidates(content)) {
    for (const claim of claims) {
      const score = relevanceScore(claim, passage)
      if (
        !best ||
        score > best.score ||
        (score === best.score && passage.length < best.passage.length)
      ) {
        best = { passage, score }
      }
    }
  }

  return best && best.score >= MIN_PASSAGE_SCORE ? best : null
}

export function lexicalAttributionForClaim(
  claim: string,
  candidateSources: readonly ContextSource[]
): LexicalAttribution | null {
  let bestMatch: LexicalAttribution | null = null

  for (const source of candidateSources) {
    const match = bestPassage([claim], source.content)
    if (!match || (bestMatch && match.score <= bestMatch.score)) continue
    bestMatch = { source, passage: match.passage, score: match.score }
  }

  return bestMatch
}

/** Add an exact, answer-relevant PDF passage without changing source content. */
export function selectCitationPassages(
  citationAnswer: string,
  citedSources: readonly ContextSource[],
  candidateSources: readonly ContextSource[] = citedSources
): ContextSource[] {
  const claims = claimsByLabel(citationAnswer)

  return citedSources.map((citedSource) => {
    const sourceClaims = claims.get(citedSource.label.toUpperCase()) ?? []
    let bestMatch:
      | { source: ContextSource; passage: string; score: number }
      | null = null

    // Models can attach the right claim to the wrong [S#]. Verify it against
    // every chunk that was genuinely supplied as context, not only that label.
    for (const candidateSource of candidateSources) {
      const match = bestPassage(sourceClaims, candidateSource.content)
      if (!match || (bestMatch && match.score <= bestMatch.score)) continue

      bestMatch = {
        source: candidateSource,
        passage: match.passage,
        score: match.score,
      }
    }

    if (!bestMatch) {
      // No claim or low confidence means page-only navigation. A missing
      // highlight is safer than confidently marking unrelated table headings.
      return { ...citedSource, highlightText: null }
    }

    return {
      ...bestMatch.source,
      // The label stays aligned with the marker already visible in the answer,
      // while its chunk/page/content are corrected to the supporting source.
      label: citedSource.label,
      highlightText: bestMatch.passage,
    }
  })
}

/**
 * Attribute model prose to retrieved evidence when the model omitted or
 * invented citation labels. Claims are temporary matching inputs; returned
 * citations remain the supporting database chunks plus their best passages.
 */
export function attributeAnswerSources(
  answer: string,
  candidateSources: readonly ContextSource[]
): ContextSource[] {
  const attributedByChunk = new Map<
    string,
    { source: ContextSource; passage: string; score: number; order: number }
  >()

  for (const [claimIndex, claim] of answerClaims(answer).entries()) {
    const bestMatch = lexicalAttributionForClaim(claim, candidateSources)

    if (!bestMatch) continue

    const existing = attributedByChunk.get(bestMatch.source.chunkId)
    if (!existing) {
      attributedByChunk.set(bestMatch.source.chunkId, {
        ...bestMatch,
        order: claimIndex,
      })
      continue
    }

    // One chunk may support several claims. Return one source chip and keep
    // whichever claim produced its strongest, safest highlight passage.
    if (bestMatch.score > existing.score) {
      attributedByChunk.set(bestMatch.source.chunkId, {
        ...bestMatch,
        order: existing.order,
      })
    }
  }

  return [...attributedByChunk.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ source, passage }) => ({
      ...source,
      highlightText: passage,
    }))
}
