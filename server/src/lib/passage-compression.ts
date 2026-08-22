import { countTokens } from './tokens.js'

export const COMPRESSED_SOURCE_TOKEN_BUDGET = 220

const COMMON_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'with',
  'what', 'which', 'who', 'how', 'why',
])

function terms(text: string): Set<string> {
  return new Set(
    (text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((word) => word.length > 1 && !COMMON_WORDS.has(word))
  )
}

function overlapScore(queryTerms: Set<string>, passage: string): number {
  const passageTerms = terms(passage)
  let score = 0

  for (const term of queryTerms) {
    if (passageTerms.has(term)) score += /^\d/.test(term) ? 3 : 1
  }
  return score
}

function compressedResult(original: string, candidate: string): string {
  const cleaned = candidate.trim()
  return cleaned && countTokens(cleaned) < countTokens(original)
    ? cleaned
    : original
}

function compressTable(
  content: string,
  queryTerms: Set<string>,
  tokenBudget: number
): string | null {
  const rows = content.split(/\r?\n/).map((row) => row.trim()).filter(Boolean)
  if (rows.length < 2 || rows.filter((row) => row.includes('|')).length < 2) {
    return null
  }

  const header = rows[0]
  if (!header) return null
  const scoredRows = rows.slice(1).map((row, index) => ({
    row,
    index,
    score: overlapScore(queryTerms, row),
  }))
  if (!scoredRows.some((row) => row.score > 0)) return content

  const selected = new Set<number>()
  for (const candidate of [...scoredRows].sort(
    (left, right) => right.score - left.score || left.index - right.index
  )) {
    if (candidate.score <= 0) break
    const proposed = [
      header,
      ...scoredRows
        .filter((row) => selected.has(row.index) || row.index === candidate.index)
        .sort((left, right) => left.index - right.index)
        .map((row) => row.row),
    ].join('\n')

    if (countTokens(proposed) > tokenBudget) continue
    selected.add(candidate.index)
  }

  if (selected.size === 0) return content
  return compressedResult(
    content,
    [
      header,
      ...scoredRows
        .filter((row) => selected.has(row.index))
        .sort((left, right) => left.index - right.index)
        .map((row) => row.row),
    ].join('\n')
  )
}

/** Safely shorten generation context while retaining complete source metadata. */
export function compressPassageForGeneration(
  content: string,
  question: string,
  tokenBudget = COMPRESSED_SOURCE_TOKEN_BUDGET
): string {
  if (countTokens(content) <= tokenBudget) return content

  const queryTerms = terms(question)
  if (queryTerms.size === 0) return content

  const table = compressTable(content, queryTerms, tokenBudget)
  if (table !== null) return table

  const sentences = content
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
  if (sentences.length < 2) return content

  const scores = sentences.map((sentence) => overlapScore(queryTerms, sentence))
  const bestScore = Math.max(...scores)
  if (bestScore <= 0) return content

  const bestIndex = scores.indexOf(bestScore)
  const selected = new Set([bestIndex])

  // Neighbouring sentences preserve definitions, pronouns, and qualifications.
  for (const index of [bestIndex - 1, bestIndex + 1]) {
    if (index < 0 || index >= sentences.length) continue
    const proposed = [...selected, index]
      .sort((left, right) => left - right)
      .map((selectedIndex) => sentences[selectedIndex])
      .join(' ')
    if (countTokens(proposed) <= tokenBudget) selected.add(index)
  }

  const candidate = [...selected]
    .sort((left, right) => left - right)
    .map((index) => sentences[index])
    .join(' ')

  return countTokens(candidate) <= tokenBudget
    ? compressedResult(content, candidate)
    : content
}
