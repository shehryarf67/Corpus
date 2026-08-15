import { randomUUID } from 'node:crypto'

export type QueryTiming = {
  requestId: string
  startedAt: number
}

export function startQueryTiming(): QueryTiming {
  return {
    // A short correlation ID lets concurrent questions be distinguished in the
    // terminal without logging the question text or other user data.
    requestId: randomUUID().slice(0, 8),
    startedAt: performance.now(),
  }
}

export function logQueryTiming(
  timing: QueryTiming | undefined,
  stage: string,
  stageStartedAt: number
): void {
  if (!timing) return

  const now = performance.now()
  console.info(
    `[query timing] request=${timing.requestId} stage=${stage}` +
      ` duration_ms=${(now - stageStartedAt).toFixed(1)}` +
      ` total_ms=${(now - timing.startedAt).toFixed(1)}`
  )
}

export async function timeQueryStage<T>(
  timing: QueryTiming | undefined,
  stage: string,
  operation: () => Promise<T>
): Promise<T> {
  const stageStartedAt = performance.now()
  try {
    return await operation()
  } finally {
    // Failed stages are timed too, which helps distinguish an immediate error
    // from a timeout that consumed the whole operation budget.
    logQueryTiming(timing, stage, stageStartedAt)
  }
}

export function timeSynchronousQueryStage<T>(
  timing: QueryTiming | undefined,
  stage: string,
  operation: () => T
): T {
  const stageStartedAt = performance.now()
  try {
    return operation()
  } finally {
    logQueryTiming(timing, stage, stageStartedAt)
  }
}
