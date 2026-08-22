import { Jobs, pool } from './lib/db.js'
import { processIngestionJob } from './services/ingestion.js'

const configuredPollInterval = Number(process.env.WORKER_POLL_INTERVAL_MS)
const POLL_INTERVAL_MS =
  Number.isFinite(configuredPollInterval) && configuredPollInterval > 0
    ? configuredPollInterval
    : 1000

const configuredHeartbeatInterval = Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS)
const HEARTBEAT_INTERVAL_MS =
  Number.isFinite(configuredHeartbeatInterval) && configuredHeartbeatInterval > 0
    ? configuredHeartbeatInterval
    : 30_000

const configuredActiveTimeout = Number(process.env.WORKER_ACTIVE_JOB_TIMEOUT_MS)
const ACTIVE_JOB_TIMEOUT_MS =
  Number.isFinite(configuredActiveTimeout) && configuredActiveTimeout > 0
    ? configuredActiveTimeout
    : 15 * 60_000

const configuredRecoveryInterval = Number(process.env.WORKER_RECOVERY_INTERVAL_MS)
const RECOVERY_INTERVAL_MS =
  Number.isFinite(configuredRecoveryInterval) && configuredRecoveryInterval > 0
    ? configuredRecoveryInterval
    : 60_000

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

let stopping = false
let activeJobId: string | null = null

function requestShutdown(signal: string): void {
  if (stopping) return
  stopping = true
  console.log(
    activeJobId
      ? `${signal} received; finishing job ${activeJobId} before shutdown`
      : `${signal} received; stopping ingestion worker`
  )
}

process.once('SIGINT', () => requestShutdown('SIGINT'))
process.once('SIGTERM', () => requestShutdown('SIGTERM'))

function startHeartbeat(jobId: string): () => void {
  let heartbeatRunning = false
  const timer = setInterval(async () => {
    if (heartbeatRunning) return
    heartbeatRunning = true
    try {
      await Jobs.heartbeat(jobId)
    } catch (error) {
      // A temporary heartbeat failure should not kill the active ingestion.
      // The normal job operation can still finish and update its final status.
      console.error(`could not heartbeat ingestion job ${jobId}`, error)
    } finally {
      heartbeatRunning = false
    }
  }, HEARTBEAT_INTERVAL_MS)

  return () => clearInterval(timer)
}

async function runWorker(): Promise<void> {
  console.log('ingestion worker started')
  let nextRecoveryAt = 0

  while (!stopping) {
    try {
      if (Date.now() >= nextRecoveryAt) {
        const abandonedJobs = await Jobs.failAbandoned(ACTIVE_JOB_TIMEOUT_MS)
        for (const abandonedJob of abandonedJobs) {
          console.warn(`marked abandoned ingestion job ${abandonedJob.id} as failed`)
        }
        nextRecoveryAt = Date.now() + RECOVERY_INTERVAL_MS
      }

      const job = await Jobs.claimNextPending()

      if (!job) {
        await wait(POLL_INTERVAL_MS)
        continue
      }

      console.log(`processing ingestion job ${job.id}`)
      activeJobId = job.id
      const stopHeartbeat = startHeartbeat(job.id)

      try {
        const result = await processIngestionJob(job.id)
        console.log(`finished job ${job.id}: ${result.chunkCount} chunks`)
      } catch (error) {
        // processIngestionJob records the failed status and error message.
        // The worker logs it, then continues looking for another job.
        console.error(`ingestion job ${job.id} failed`, error)
      } finally {
        stopHeartbeat()
        activeJobId = null
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
