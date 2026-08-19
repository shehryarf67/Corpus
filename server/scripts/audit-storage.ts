import { Documents, pool } from '../src/lib/db.js'
import { auditStorageKeys, type StorageKeyAudit } from '../src/lib/storage-audit.js'
import {
  listStoredPdfKeys,
  listStoredThumbnailKeys,
} from '../src/lib/storage.js'

function printAudit(label: string, audit: StorageKeyAudit): void {
  console.log(`\n${label}`)
  console.log(`  orphaned files: ${audit.orphanedFiles.length}`)
  for (const key of audit.orphanedFiles) console.log(`    ${key}`)
  console.log(`  missing files: ${audit.missingFiles.length}`)
  for (const key of audit.missingFiles) console.log(`    ${key}`)
}

async function main() {
  const documents = await Documents.getAll()
  const pdfAudit = auditStorageKeys(
    await listStoredPdfKeys(),
    documents.flatMap((document) =>
      document.storage_key ? [document.storage_key] : []
    )
  )
  const thumbnailAudit = auditStorageKeys(
    await listStoredThumbnailKeys(),
    documents.flatMap((document) =>
      document.thumbnail_key ? [document.thumbnail_key] : []
    )
  )

  printAudit('PDF storage', pdfAudit)
  printAudit('Thumbnail storage', thumbnailAudit)

  const problemCount =
    pdfAudit.orphanedFiles.length +
    pdfAudit.missingFiles.length +
    thumbnailAudit.orphanedFiles.length +
    thumbnailAudit.missingFiles.length

  if (problemCount === 0) {
    console.log('\nStorage audit passed.')
  } else {
    console.error(`\nStorage audit found ${problemCount} problem(s).`)
    // A non-zero code makes scheduled maintenance/CI able to detect drift.
    // The command remains read-only and never removes files automatically.
    process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
