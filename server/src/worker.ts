import { Jobs, pool } from './lib/db.js'
import { processIngestionJob } from './services/ingestion.js'

const configuredPollInterval = Number(process.env.WORKER_POLL_INTERVAL_MS)
const POLL_INTERVAL_MS =
  Number.isFinite(configuredPollInterval) && configuredPollInterval > 0
    ? configuredPollInterval
    : 1000

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

let stopping = false

process.on('SIGINT', () => {
  stopping = true
})

process.on('SIGTERM', () => {
  stopping = true
})

async function runWorker(): Promise<void> {
  console.log('ingestion worker started')

  while (!stopping) {
    try {
      const job = await Jobs.claimNextPending()

      if (!job) {
        await wait(POLL_INTERVAL_MS)
        continue
      }

      console.log(`processing ingestion job ${job.id}`)

      try {
        const result = await processIngestionJob(job.id)
        console.log(`finished job ${job.id}: ${result.chunkCount} chunks`)
      } catch (error) {
        // processIngestionJob records the failed status and error message.
        // The worker logs it, then continues looking for another job.
        console.error(`ingestion job ${job.id} failed`, error)
      }
    } catch (error) {
      // A database connection error while looking for work should not end
      // the worker permanently. Wait briefly before trying again.
      console.error('worker could not claim a job', error)
      await wait(POLL_INTERVAL_MS)
    }
  }

  await pool.end()
  console.log('ingestion worker stopped')
}

runWorker().catch((error) => {
  console.error('ingestion worker stopped unexpectedly', error)
  process.exitCode = 1
})
