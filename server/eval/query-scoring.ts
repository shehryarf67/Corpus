const REFUSAL_PHRASES = [
  'could not find',
  'cannot find',
  'not found in the document',
  'not provided',
  'not specified',
  'not mentioned',
  'does not contain',
  "doesn't contain",
  'insufficient information',
  'document does not say',
  "document doesn't say",
  'unable to determine',
  'no information about',
]

function normalized(text: string): string {
  return text.toLocaleLowerCase().replaceAll('–', '-').replaceAll('—', '-')
}

export function calculateFactCoverage(
  answer: string,
  expectedFactGroups: readonly (readonly string[])[]
): number | null {
  if (expectedFactGroups.length === 0) return null

  const normalizedAnswer = normalized(answer)
  const matchedGroups = expectedFactGroups.filter((alternatives) =>
    alternatives.some((alternative) =>
      normalizedAnswer.includes(normalized(alternative))
    )
  ).length

  return matchedGroups / expectedFactGroups.length
}

export function looksLikeRefusal(answer: string): boolean {
  const normalizedAnswer = normalized(answer)
  return REFUSAL_PHRASES.some((phrase) => normalizedAnswer.includes(phrase))
}

export function hasCanonicalCitation(answer: string): boolean {
  return /\[S\d+\]/i.test(answer)
}
