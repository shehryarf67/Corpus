import assert from 'node:assert/strict'
import test from 'node:test'
import { auditStorageKeys } from './storage-audit.js'

test('auditStorageKeys reports orphaned and missing files separately', () => {
  assert.deepEqual(
    auditStorageKeys(
      ['shared.pdf', 'orphaned.pdf'],
      ['shared.pdf', 'missing.pdf']
    ),
    {
      orphanedFiles: ['orphaned.pdf'],
      missingFiles: ['missing.pdf'],
    }
  )
})

test('auditStorageKeys reports a clean matching storage set', () => {
  assert.deepEqual(auditStorageKeys(['one.pdf'], ['one.pdf']), {
    orphanedFiles: [],
    missingFiles: [],
  })
})
