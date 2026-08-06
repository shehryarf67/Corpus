import { Hono } from 'hono'
import { pool } from '../src/lib/db.js'
import { queryRoute } from '../src/routes/query.js'
import { queryEvaluationCases } from './query-dataset.js'
import { calculateFactCoverage } from './query-scoring.js'

type TimedEvent = {
  event: string
  data: Record<string, unknown>
  elapsedMs: number
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
  if (!document) throw new Error('No ingested test PDF was found')
  return document.id
}

function parseBlock(block: string, elapsedMs: number): TimedEvent {
  const lines = block.split('\n')
  const event = lines.find((line) => line.startsWith('event: '))?.slice(7)
  const data = lines
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .join('\n')

  if (!event || !data) throw new Error(`Invalid SSE block: ${block}`)
  return {
    event,
    data: JSON.parse(data) as Record<string, unknown>,
    elapsedMs,
  }
}

async function readTimedEvents(
  response: Response,
  startedAt: number
): Promise<TimedEvent[]> {
  if (!response.body) throw new Error('SSE response did not contain a body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: TimedEvent[] = []
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')

      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (block.trim()) {
          events.push(parseBlock(block, performance.now() - startedAt))
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
  return events
}

async function main(): Promise<void> {
  const requestedId = process.env.EVAL_CASE_ID ?? 'evaluation-tasks'
  const evaluationCase = queryEvaluationCases.find(
    (candidate) => candidate.id === requestedId
  )
  const turn = evaluationCase?.turns[0]
  if (!evaluationCase || !turn) {
    throw new Error(`Streaming eval requires a valid case ID: ${requestedId}`)
  }

  const documentId = await findEvaluationDocumentId()
  const app = new Hono()
  app.route('/query', queryRoute)
  let conversationId: string | undefined

  try {
    const startedAt = performance.now()
    const response = await app.request('/query/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId, question: turn.question }),
    })
    const responseStartedMs = performance.now() - startedAt
    const events = await readTimedEvents(response, startedAt)
    const firstEvent = events[0]
    const firstToken = events.find((event) => event.event === 'token')
    const done = events.findLast((event) => event.event === 'done')

    if (!firstEvent || !firstToken || !done) {
      throw new Error('Streaming evaluation did not receive required SSE events')
    }

    conversationId = String(firstEvent.data.conversationId ?? '')
    const finalAnswer = String(done.data.answer ?? '')
    const factCoverage = calculateFactCoverage(
      finalAnswer,
      turn.expectedFactGroups
    )

    console.table([
      {
        case: evaluationCase.id,
        responseStartedMs: Math.round(responseStartedMs),
        firstEventMs: Math.round(firstEvent.elapsedMs),
        firstTokenMs: Math.round(firstToken.elapsedMs),
        totalMs: Math.round(done.elapsedMs),
        tokenEvents: events.filter((event) => event.event === 'token').length,
        factCoverage: factCoverage?.toFixed(3) ?? '-',
        answer: finalAnswer.slice(0, 120),
      },
    ])
  } finally {
    if (conversationId) {
      await pool.query('DELETE FROM conversations WHERE id = $1', [conversationId])
    }
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
