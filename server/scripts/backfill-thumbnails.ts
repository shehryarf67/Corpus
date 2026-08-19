import { Documents, pool } from '../src/lib/db.js'
import { readPdf } from '../src/lib/storage.js'
import { ensureDocumentThumbnail } from '../src/services/document-thumbnail.js'

async function main() {
  const documents = await Documents.getAll()
  let created = 0

  for (const document of documents) {
    if (!document.storage_key || document.thumbnail_key) continue

    try {
      await ensureDocumentThumbnail(document, await readPdf(document.storage_key))
      created += 1
    } catch (error) {
      // One damaged or missing legacy PDF should not stop previews for others.
      console.error(`could not backfill thumbnail for ${document.id}`, error)
    }
  }

  console.log(`thumbnail backfill complete: ${created} created`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
