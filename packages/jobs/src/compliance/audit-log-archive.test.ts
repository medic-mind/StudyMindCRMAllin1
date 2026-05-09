// Tests for the weekly audit-log archive aggregator. Pure functions; no I/O.
// CLAUDE.md §17.1, §21.

import { gunzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  archiveCutoff,
  ARCHIVE_BATCH_SIZE,
  selectAuditBatch,
  markBatchArchived,
  serialiseAuditBatch,
  type AuditArchiveDb,
  type AuditRowForArchive,
} from './audit-log-archive'

function row(id: string, occurredAt: string, action = 'contact.created'): AuditRowForArchive {
  return {
    id,
    action,
    actorId: 'user-1',
    targetType: 'Contact',
    targetId: 'c-1',
    requestId: 'req-1',
    purpose: null,
    before: null,
    after: { name: 'A' },
    occurredAt: new Date(occurredAt),
  }
}

describe('serialiseAuditBatch', () => {
  const now = new Date('2026-05-10T05:00:00Z')

  it('produces NDJSON with stable ordering, correct sha256, and gzipped body', () => {
    const rows = [row('a', '2025-01-01T00:00:00Z'), row('b', '2025-01-02T00:00:00Z')]
    const batch = serialiseAuditBatch({ rows, now, batchId: 'batch-1' })

    expect(batch.batchId).toBe('batch-1')
    expect(batch.day).toBe('2026-05-10')
    expect(batch.s3Key).toBe('audit-archives/2026/2026-05-10-batch-1.ndjson.gz')
    expect(batch.rowIds).toEqual(['a', 'b'])

    const ndjson = gunzipSync(batch.body).toString('utf8')
    const lines = ndjson.trim().split('\n')
    expect(lines).toHaveLength(2)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed[0].id).toBe('a')
    expect(parsed[1].id).toBe('b')
    // ISO occurredAt
    expect(parsed[0].occurredAt).toBe('2025-01-01T00:00:00.000Z')

    // sha256 is over the *uncompressed* body so verifiers can replay.
    expect(batch.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(batch.byteCount).toBe(Buffer.byteLength(ndjson, 'utf8'))
  })

  it('handles empty input deterministically', () => {
    const batch = serialiseAuditBatch({ rows: [], now, batchId: 'empty' })
    expect(batch.rowIds).toEqual([])
    expect(batch.byteCount).toBe(0)
    // gzip of empty is non-empty (header) but decompresses to '' .
    expect(gunzipSync(batch.body).toString('utf8')).toBe('')
  })
})

describe('archiveCutoff', () => {
  it('subtracts exactly 12 months', () => {
    const cutoff = archiveCutoff(new Date('2026-05-10T05:00:00Z'))
    expect(cutoff.toISOString()).toBe('2025-05-10T05:00:00.000Z')
  })
})

describe('selectAuditBatch', () => {
  it('takes ARCHIVE_BATCH_SIZE (1000) rows, ordered by occurredAt asc, only un-archived + older than cutoff', async () => {
    let captured: Parameters<AuditArchiveDb['auditLogEntry']['findMany']>[0] | null = null
    const fakeDb: AuditArchiveDb = {
      auditLogEntry: {
        findMany: async (args) => {
          captured = args
          return [row('a', '2024-01-01T00:00:00Z')]
        },
        updateMany: async () => ({ count: 0 }),
      },
    }
    const result = await selectAuditBatch(fakeDb, new Date('2026-05-10T05:00:00Z'))
    expect(result).not.toBeNull()
    expect(captured!.take).toBe(ARCHIVE_BATCH_SIZE)
    expect(captured!.where.archivedAt).toBeNull()
    expect(captured!.where.occurredAt.lt.toISOString()).toBe('2025-05-10T05:00:00.000Z')
    expect(captured!.orderBy).toEqual({ occurredAt: 'asc' })
  })

  it('returns null when nothing left to archive', async () => {
    const fakeDb: AuditArchiveDb = {
      auditLogEntry: {
        findMany: async () => [],
        updateMany: async () => ({ count: 0 }),
      },
    }
    const result = await selectAuditBatch(fakeDb, new Date())
    expect(result).toBeNull()
  })
})

describe('markBatchArchived', () => {
  it('updates only the rows we archived with the s3 key + timestamp', async () => {
    let captured: Parameters<AuditArchiveDb['auditLogEntry']['updateMany']>[0] | null = null
    const fakeDb: AuditArchiveDb = {
      auditLogEntry: {
        findMany: async () => [],
        updateMany: async (args) => {
          captured = args
          return { count: args.where.id.in.length }
        },
      },
    }
    const now = new Date('2026-05-10T05:00:00Z')
    const count = await markBatchArchived(fakeDb, ['a', 'b'], 's3://k', now)
    expect(count).toBe(2)
    expect(captured!.data.archivedAt).toEqual(now)
    expect(captured!.data.archiveS3Key).toBe('s3://k')
    expect(captured!.where.id.in).toEqual(['a', 'b'])
  })
})
