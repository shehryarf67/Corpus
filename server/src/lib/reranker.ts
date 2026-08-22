import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
} from '@xenova/transformers'
import type { FusedChunk } from './rrf.js'

const RERANKER_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2'
const MAX_INPUT_TOKENS = 512

// Loading a model is expensive. These promises are created only on the first
// reranking request, then reused by every later request in this server process.
let tokenizerPromise: ReturnType<typeof AutoTokenizer.from_pretrained> | null = null
let modelPromise: ReturnType<
  typeof AutoModelForSequenceClassification.from_pretrained
> | null = null

export type RerankedChunk = FusedChunk & {
  rerankerScore: number
}

export type PassagePair = {
  query: string
  passage: string
}

function loadReranker() {
  tokenizerPromise ??= AutoTokenizer.from_pretrained(RERANKER_MODEL)
  modelPromise ??=
    AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL)

  return Promise.all([tokenizerPromise, modelPromise])
}

// Kept separate from model execution so score attachment and sorting can be
// tested quickly without loading the real model.
export function attachRerankerScores(
  candidates: readonly FusedChunk[],
  scores: readonly number[]
): RerankedChunk[] {
  if (candidates.length !== scores.length) {
    throw new Error(
      `Reranker returned ${scores.length} scores for ${candidates.length} chunks`
    )
  }

  return candidates
    .map((chunk, index) => {
      const rerankerScore = scores[index]
      if (rerankerScore === undefined || !Number.isFinite(rerankerScore)) {
        throw new Error(`Invalid reranker score at index ${index}`)
      }

      return { ...chunk, rerankerScore }
    })
    .sort(
      (a, b) =>
        b.rerankerScore - a.rerankerScore ||
        b.rrfScore - a.rrfScore ||
        a.chunk_index - b.chunk_index
    )
}

export async function rerankChunks(
  question: string,
  candidates: readonly FusedChunk[]
): Promise<RerankedChunk[]> {
  if (candidates.length === 0) return []

  const scores = await scorePassagePairs(
    candidates.map((chunk) => ({ query: question, passage: chunk.content }))
  )

  return attachRerankerScores(candidates, scores)
}

/** Score arbitrary query/passage pairs with the same cached cross-encoder. */
export async function scorePassagePairs(
  pairs: readonly PassagePair[]
): Promise<number[]> {
  if (pairs.length === 0) return []

  const [tokenizer, model] = await loadReranker()
  const questions = pairs.map((pair) => pair.query)
  const passages = pairs.map((pair) => pair.passage)
  const inputs = tokenizer(questions, {
    text_pair: passages,
    padding: true,
    truncation: true,
    max_length: MAX_INPUT_TOKENS,
  })

  // This model returns one raw relevance logit for each question/chunk pair.
  // Raw scores are fine because we only compare candidates for one question.
  const output = await model(inputs)
  return Array.from(output.logits.data, (score) => Number(score))
}
