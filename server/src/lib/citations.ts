import type { ContextSource } from './context.js'

export type ValidatedCitations = {
  answer: string
  sources: ContextSource[]
  invalidLabels: string[]
}

// Ollama sometimes identifies the correct source but writes the wrapper-like
// form `source id="S4", page=3` instead of the requested `[S4]`. Normalize
// the known variants first so validation works with one canonical format.
function normalizeCitationSyntax(answer: string): string {
  return answer
    .replace(
      /\bsource\s+id\s*=\s*["']?(S\d+)["']?(?:\s*,?\s*page\s*=\s*["']?[^,\s"']+["']?)?/gi,
      (_, label: string) => `[${label.toUpperCase()}]`
    )
    .replace(
      /\[(S\d+)\s*\|\s*page\s+[^\]]+\]/gi,
      (_, label: string) => `[${label.toUpperCase()}]`
    )
}

// Validate model-written citations against the exact source labels that were
// supplied in this request. This checks that a source exists; it does not yet
// prove that the source text semantically supports the model's claim.
export function validateCitations(
  rawAnswer: string,
  availableSources: ContextSource[]
): ValidatedCitations {
  const sourcesByLabel = new Map(
    availableSources.map((source) => [source.label.toUpperCase(), source])
  )
  const citedLabels: string[] = []
  const invalidLabels: string[] = []

  const answer = normalizeCitationSyntax(rawAnswer)
    .replace(/\[(S\d+)\]/gi, (_, rawLabel: string) => {
        const label = rawLabel.toUpperCase()

        if (!sourcesByLabel.has(label)) {
          if (!invalidLabels.includes(label)) invalidLabels.push(label)
          return ''
        }

        if (!citedLabels.includes(label)) citedLabels.push(label)
        return `[${label}]`
      })
    // Removing an invented marker can leave a space before punctuation.
    .replace(/\s+([.,;:!?])/g, '$1')

  return {
    answer,
    // Preserve the order in which citations first appear in the answer,
    // rather than returning every retrieved source whether it was cited or not.
    sources: citedLabels.map((label) => sourcesByLabel.get(label)!),
    invalidLabels,
  }
}
