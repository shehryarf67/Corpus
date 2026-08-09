import { Conversations, Documents, pool } from '../src/lib/db.js'
import { queryConversation } from '../src/services/query.js'
import { queryEvaluationCases } from './query-dataset.js'
import {
  calculateFactCoverage,
  hasCanonicalCitation,
  looksLikeRefusal,
} from './query-scoring.js'

type EvaluationRow = {
  caseId: string
  turn: number
  question: string
  answer: string
  factCoverage: number | null
  refused: boolean
  shouldRefuse: boolean
  citationPresent: boolean
  citedExpectedPage: boolean
  sourceCount: number
  latencyMs: number
  passed: boolean
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

function formattedRate(values: number[]): string {
  return values.length === 0 ? '-' : average(values).toFixed(3)
}

async function findEvaluationDocumentId(): Promise<string> {
  if (process.env.EVAL_DOCUMENT_ID) return process.env.EVAL_DOCUMENT_ID

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
      'No ingested test PDF was found. Set EVAL_DOCUMENT_ID to an ingested document ID.'
    )
  }
  return document.id
}

function selectedCases() {
  const requestedId = process.env.EVAL_CASE_ID
  const requestedLimit = Number.parseInt(process.env.EVAL_CASE_LIMIT ?? '', 10)

  let cases = requestedId
    ? queryEvaluationCases.filter((evaluationCase) => evaluationCase.id === requestedId)
    : queryEvaluationCases

  if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
    cases = cases.slice(0, requestedLimit)
  }

  if (cases.length === 0) {
    throw new Error(`No query evaluation case matched EVAL_CASE_ID=${requestedId}`)
  }
  return cases
}

async function main(): Promise<void> {
  const documentId = await findEvaluationDocumentId()
  const document = await Documents.getById(documentId)
  if (!document) throw new Error('Evaluation document was not found')
  const rows: EvaluationRow[] = []
  const cases = selectedCases()
  let activeConversationId: string | undefined

  // Ctrl+C normally ends Node immediately and skips the per-case finally block.
  // Clean the exact active evaluation conversation before exiting instead.
  const handleInterrupt = () => {
    void (async () => {
      if (activeConversationId) {
        await pool.query('DELETE FROM conversations WHERE id = $1', [
          activeConversationId,
        ])
      }
      await pool.end()
      process.exit(130)
    })()
  }
  process.once('SIGINT', handleInterrupt)

  try {
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      const evaluationCase = cases[caseIndex]
      if (!evaluationCase) continue

      const conversation = await Conversations.create(documentId)
      if (!conversation) throw new Error('Failed to create evaluation conversation')
      activeConversationId = conversation.id

      try {
        for (let index = 0; index < evaluationCase.turns.length; index++) {
          const turn = evaluationCase.turns[index]
          if (!turn) continue

          console.log(
            `[${caseIndex + 1}/${cases.length}] ${evaluationCase.id}, turn ${index + 1}/${evaluationCase.turns.length}`
          )

          const startedAt = performance.now()
          const result = await queryConversation(
            documentId,
            turn.question,
            document.user_id,
            conversation.id
          )
          const latencyMs = performance.now() - startedAt
          const factCoverage = calculateFactCoverage(
            result.answer,
            turn.expectedFactGroups
          )
          const refused = looksLikeRefusal(result.answer)
          const shouldRefuse = turn.shouldRefuse ?? false
          const citedExpectedPage = result.sources.some(
            (source) =>
              source.pageNumber !== null &&
              turn.expectedPages.includes(source.pageNumber)
          )
          const passed = shouldRefuse
            ? refused
            : factCoverage === 1 && !refused

          rows.push({
            caseId: evaluationCase.id,
            turn: index + 1,
            question: turn.question,
            answer: result.answer,
            factCoverage,
            refused,
            shouldRefuse,
            citationPresent: hasCanonicalCitation(result.answer),
            citedExpectedPage,
            sourceCount: result.sources.length,
            latencyMs,
            passed,
          })
        }
      } finally {
        await pool.query('DELETE FROM conversations WHERE id = $1', [conversation.id])
        activeConversationId = undefined
      }
    }

    console.log(`Document: ${documentId}`)
    console.table(
      rows.map((row) => ({
        case: row.caseId,
        turn: row.turn,
        passed: row.passed,
        coverage: row.factCoverage === null ? '-' : row.factCoverage.toFixed(2),
        refused: row.refused,
        citation: row.citationPresent,
        expectedPageCited: row.citedExpectedPage,
        sources: row.sourceCount,
        latencyMs: Math.round(row.latencyMs),
        answer: row.answer.slice(0, 120),
      }))
    )

    const answerable = rows.filter((row) => !row.shouldRefuse)
    const unanswerable = rows.filter((row) => row.shouldRefuse)
    const followUps = rows.filter((row) => row.turn > 1)

    console.table([
      {
        metric: 'overall pass rate',
        value: formattedRate(rows.map((row) => (row.passed ? 1 : 0))),
      },
      {
        metric: 'average fact coverage',
        value: formattedRate(
          answerable.map((row) => row.factCoverage ?? 0)
        ),
      },
      {
        metric: 'citation presence rate',
        value: formattedRate(
          answerable.map((row) => (row.citationPresent ? 1 : 0))
        ),
      },
      {
        metric: 'expected page citation rate',
        value: formattedRate(
          answerable.map((row) => (row.citedExpectedPage ? 1 : 0))
        ),
      },
      {
        metric: 'refusal accuracy',
        value: formattedRate(
          unanswerable.map((row) => (row.refused ? 1 : 0))
        ),
      },
      {
        metric: 'follow-up pass rate',
        value: formattedRate(
          followUps.map((row) => (row.passed ? 1 : 0))
        ),
      },
      {
        metric: 'average latency ms',
        value: Math.round(average(rows.map((row) => row.latencyMs))),
      },
    ])
  } finally {
    process.removeListener('SIGINT', handleInterrupt)
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
