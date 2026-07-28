import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { pool } from './lib/db.js'

const app = new Hono()
app.use('*', cors({ origin: 'http://localhost:3000' }))
app.get('/health', (c) => c.json({ ok: true }))
app.get('/health/db', async (c) => {
  const { rows } = await pool.query('select version()')
  return c.json({ ok: true, version: rows[0].version })
})

serve({ fetch: app.fetch, port: 3001 })
console.log('server on :3001')
