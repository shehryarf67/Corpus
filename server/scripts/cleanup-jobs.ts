import { Jobs, pool } from '../src/lib/db.js'

const configuredRetentionDays = Number(process.env.JOB_RETENTION_DAYS)
const retentionDays =
  Number.isInteger(configuredRetentionDays) && configuredRetentionDays > 0
    ? configuredRetentionDays
    : 90

async function main(): Promise<void> {
  const deletedCount = await Jobs.deleteOldTerminalAttempts(retentionDays)
  console.log(
    `Removed ${deletedCount} superseded terminal job(s) older than ${retentionDays} days.`
  )
}

main()
  .catch((error) => {
    console.error('Job cleanup failed', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
