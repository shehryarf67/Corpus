import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'

const migrationsDir = path.join(import.meta.dirname, '..', 'migrations')

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const files = (await readdir(migrationsDir)).filter((f: string) => f.endsWith('.sql')).sort()
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations')
  const applied = new Set(rows.map((r) => r.name))

  for (const file of files) {
    if (applied.has(file)) continue

    const sql = await readFile(path.join(migrationsDir, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
      console.log(`applied ${file}`)
    } catch (err) {
      await client.query('ROLLBACK')
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`migration ${file} failed: ${message}`)
    } finally {
      client.release()
    }
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
