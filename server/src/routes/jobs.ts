import { Hono } from 'hono'
import { Jobs } from '../lib/db.js'
import { requireAuth, type AuthEnv } from '../middleware/auth.js'

export const jobsRoute = new Hono<AuthEnv>()

// Every job-status request must establish an authenticated user first.
jobsRoute.use(requireAuth)

jobsRoute.get('/:jobId', async (c) => {
  const jobId = c.req.param('jobId')

  try {
    const job = await Jobs.getById(jobId)

    if (!job) {
      return c.json({ error: 'Job not found' }, 404)
    }

    return c.json({
      jobId: job.id,
      documentId: job.document_id,
      type: job.type,
      status: job.status,
      error: job.error,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    })
  } catch (error) {
    console.error(`could not retrieve job ${jobId}`, error)
    return c.json({ error: 'Could not retrieve job status' }, 500)
  }
})
