import { get_encoding } from 'tiktoken'

// Loading the BPE table is expensive, so every token-budget feature shares one
// process-wide encoder instead of creating and freeing one on every call.
const encoder = get_encoding('cl100k_base')
const decoder = new TextDecoder()

export function countTokens(text: string): number {
  return encoder.encode(text).length
}

export function keepLastTokens(text: string, maximumTokens: number): string {
  if (maximumTokens <= 0) return ''

  const tokens = encoder.encode(text)
  if (tokens.length <= maximumTokens) return text

  return decoder.decode(encoder.decode(tokens.slice(-maximumTokens))).trim()
}
