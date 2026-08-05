import { Chunks, pool } from '../src/lib/db.js'
import { embed } from '../src/lib/embeddings.js'
import { fuseWithRRF } from '../src/lib/rrf.js'
import { rerankChunks } from '../src/lib/reranker.js'
import { retrievalDataset } from './retrieval-dataset.js'

const CANDIDATE_LIMIT = 20
const METRIC_K = 5
const RERANK_CANDIDATE_LIMIT = 15

type RankedChunk = {
  chunk_index: number
}

type StrategyResult = {
  rank: number | null
  topFive: number[]
}

function rankExpectedChunk(
  results: readonly RankedChunk[],
  expectedChunkIndexes: readonly number[]
): number | null {
  const index = results.findIndex((result) =>
    expectedChunkIndexes.includes(result.chunk_index)
  )
  return index === -1 ? null : index + 1
}

function summarizeStrategy(
  results: readonly RankedChunk[],
  expectedChunkIndexes: readonly number[]
): StrategyResult {
  return {
    rank: rankExpectedChunk(results, expectedChunkIndexes),
    topFive: results.slice(0, METRIC_K).map((result) => result.chunk_index),
  }
}

function formatRank(rank: number | null): string {
  return rank === null ? '-' : String(rank)
}

function calculateMetrics(ranks: Array<number | null>) {
  const recallAtFive =
    ranks.filter((rank) => rank !== null && rank <= METRIC_K).length / ranks.length
  const mrr =
    ranks.reduce<number>((total, rank) => total + (rank === null ? 0 : 1 / rank), 0) /
    ranks.length

  return { recallAtFive, mrr }
}

async function findEvaluationDocumentId(): Promise<string> {
  if (process.env.EVAL_DOCUMENT_ID) return process.env.EVAL_DOCUMENT_ID

  // docs/test_pdf.pdf is byte-identical to the fixture used by the complete
  // ingestion test. Find the newest ingested copy when no explicit ID is set.
  const { rows } = await pool.query<{ id: string }>(
    `SELECT documents.id
     FROM documents
     JOIN chunks ON chunks.document_id = documents.id
     WHERE documents.filename IN ('test.pdf', 'test_pdf.pdf')
     GROUP BY documents.id, documents.uploaded_at
     ORDER BY documents.uploaded_at DESC
     LIMIT 1`
  )

  const document = rows[0]
  if (!document) {
    throw new Error(
      'No ingested test_pdf.pdf was found. Set EVAL_DOCUMENT_ID to an ingested document ID.'
    )
  }
  return document.id
}

async function main(): Promise<void> {
  try {
    const documentId = await findEvaluationDocumentId()
    const questions = retrievalDataset.map((evaluationCase) => evaluationCase.question)
    const embeddings = await embed(questions, 'query')
    const rows = []
    const vectorRanks: Array<number | null> = []
    const keywordRanks: Array<number | null> = []
    const hybridRanks: Array<number | null> = []
    const rerankedRanks: Array<number | null> = []

    for (let index = 0; index < retrievalDataset.length; index++) {
      const evaluationCase = retrievalDataset[index]
      const queryEmbedding = embeddings[index]
      if (!evaluationCase || !queryEmbedding) {
        throw new Error(`Missing evaluation data at index ${index}`)
      }

      const [vectorResults, keywordResults] = await Promise.all([
        Chunks.searchSimilar(documentId, queryEmbedding, CANDIDATE_LIMIT),
        Chunks.searchByKeyword(documentId, evaluationCase.question, CANDIDATE_LIMIT),
      ])
      const hybridResults = fuseWithRRF(vectorResults, keywordResults)
      const rerankedResults = await rerankChunks(
        evaluationCase.question,
        hybridResults.slice(0, RERANK_CANDIDATE_LIMIT)
      )

      const vector = summarizeStrategy(
        vectorResults,
        evaluationCase.expectedChunkIndexes
      )
      const keyword = summarizeStrategy(
        keywordResults,
        evaluationCase.expectedChunkIndexes
      )
      const hybrid = summarizeStrategy(
        hybridResults,
        evaluationCase.expectedChunkIndexes
      )
      const reranked = summarizeStrategy(
        rerankedResults,
        evaluationCase.expectedChunkIndexes
      )

      vectorRanks.push(vector.rank)
      keywordRanks.push(keyword.rank)
      hybridRanks.push(hybrid.rank)
      rerankedRanks.push(reranked.rank)
      rows.push({
        question: evaluationCase.question,
        expectedPage: evaluationCase.expectedPage,
        expectedChunks: evaluationCase.expectedChunkIndexes.join(','),
        vectorRank: formatRank(vector.rank),
        keywordRank: formatRank(keyword.rank),
        hybridRank: formatRank(hybrid.rank),
        rerankedRank: formatRank(reranked.rank),
        vectorTop5: vector.topFive.join(','),
        keywordTop5: keyword.topFive.join(','),
        hybridTop5: hybrid.topFive.join(','),
        rerankedTop5: reranked.topFive.join(','),
      })
    }

    console.log(`Document: ${documentId}`)
    console.table(rows)

    const metrics = [
      { strategy: 'vector', ...calculateMetrics(vectorRanks) },
      { strategy: 'keyword', ...calculateMetrics(keywordRanks) },
      { strategy: 'hybrid', ...calculateMetrics(hybridRanks) },
      { strategy: 'reranked', ...calculateMetrics(rerankedRanks) },
    ]
    console.table(
      metrics.map((metric) => ({
        strategy: metric.strategy,
        recallAt5: metric.recallAtFive.toFixed(3),
        mrr: metric.mrr.toFixed(3),
      }))
    )
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
