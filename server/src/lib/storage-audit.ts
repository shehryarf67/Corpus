export type StorageKeyAudit = {
  orphanedFiles: string[]
  missingFiles: string[]
}

/** Compare disk with Postgres without deleting or changing either side. */
export function auditStorageKeys(
  storedKeys: Iterable<string>,
  referencedKeys: Iterable<string>
): StorageKeyAudit {
  const stored = new Set(storedKeys)
  const referenced = new Set(referencedKeys)

  return {
    // File exists, but no document row points at it.
    orphanedFiles: [...stored].filter((key) => !referenced.has(key)).sort(),
    // Document row points at a file that no longer exists.
    missingFiles: [...referenced].filter((key) => !stored.has(key)).sort(),
  }
}
