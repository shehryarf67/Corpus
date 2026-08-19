import { Documents, type DocumentRow } from '../lib/db.js'
import { renderFirstPageThumbnail } from '../lib/pdf/thumbnail.js'
import {
  deleteThumbnail,
  saveThumbnail,
} from '../lib/storage.js'

/**
 * Generate and attach a preview when one is missing. Rendering is called from
 * the worker, while this helper keeps file and database cleanup in one place.
 */
export async function ensureDocumentThumbnail(
  document: DocumentRow,
  fileBuffer: Buffer
): Promise<void> {
  if (document.thumbnail_key) return

  const thumbnailBuffer = await renderFirstPageThumbnail(fileBuffer)
  const thumbnailKey = await saveThumbnail(thumbnailBuffer)

  try {
    const updated = await Documents.setThumbnailKeyIfMissing(
      document.id,
      thumbnailKey
    )

    // The row may have been deleted, or another worker may have won the race.
    // In either case this newly written image is not referenced and is removed.
    if (!updated) await deleteThumbnail(thumbnailKey)
  } catch (error) {
    await deleteThumbnail(thumbnailKey).catch(() => undefined)
    throw error
  }
}
