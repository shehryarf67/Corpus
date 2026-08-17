import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { pool } from './lib/db.js'
import { warmGenerationModel } from './lib/generation.js'
import { authRoute } from './routes/auth.js'
import { documentsRoute } from './routes/documents.js'
import { jobsRoute } from './routes/jobs.js'
import { queryRoute } from './routes/query.js'

const app = new Hono()
// Credentials allows the frontend to send and receive the HttpOnly session
// cookie across the localhost frontend/backend ports.
app.use('*', cors({ origin: 'http://localhost:3000', credentials: true }))
app.get('/health', (c) => c.json({ ok: true }))
app.get('/health/db', async (c) => {
  const { rows } = await pool.query('select version()')
  return c.json({ ok: true, version: rows[0].version })
})
app.route('/auth', authRoute)
app.route('/documents', documentsRoute)
app.route('/jobs', jobsRoute)
app.route('/query', queryRoute)

serve({ fetch: app.fetch, port: 3001 })
console.log('server on :3001')

// Start listening immediately, then preload Ollama in the background. A local
// Ollama outage should not take down uploads, document viewing, or auth; query
// requests can still retry model loading after the warning below.
const warmupStartedAt = performance.now()
void warmGenerationModel()
  .then(() => {
    const elapsedSeconds = (performance.now() - warmupStartedAt) / 1000
    console.log(`Ollama model warmed in ${elapsedSeconds.toFixed(1)}s`)
  })
  .catch((error: unknown) => {
    console.warn('Ollama warm-up failed; the first query may be slower', error)
  })
