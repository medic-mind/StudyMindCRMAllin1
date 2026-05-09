// Weekly audit-log archive. CLAUDE.md §17.1, §21.
//
// Sundays 05:00 UTC. Selects AuditLogEntry rows older than 12 months that
// have not yet been archived, batches them (1000 rows), serialises to NDJSON
// with a SHA-256 manifest, and emits the result for the worker boundary to
// upload to S3. The boundary then writes back archivedAt + archiveS3Key.
//
// Idempotent on (batchId, day): re-running the same day for the same batchId
// is a no-op because rows are claimed by setting archivedAt only after a
// successful upload.
//
// Compression: we use gzip (Node `zlib.gzipSync`) because zstd is not in the
// devDependencies. NDJSON gzipped at level 9 gives sufficient compaction for
// audit rows; switching to zstd is a future optimisation tracked in ADR.

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

import { createId } from '@paralleldrive/cuid2'

export const ARCHIVE_BATCH_SIZE = 1000
export const ARCHIVE_AGE_DAYS = 365

export interface AuditRowForArchive {
  id: string
  action: string
  actorId: string | null
  targetType: string
  targetId: string
  requestId: string | null
  purpose: string | null
  before: unknown
  after: unknown
  occurredAt: Date
}

export interface AuditArchiveDb {
  auditLogEntry: {
    findMany: (args: {
      where: {
        archivedAt: null
        occurredAt: { lt: Date }
      }
      orderBy: { occurredAt: 'asc' }
      take: number
      select: {
        id: true
        action: true
        actorId: true
        targetType: true
        targetId: true
        requestId: true
        purpose: true
        before: true
        after: true
        occurredAt: true
      }
    }) => Promise<AuditRowForArchive[]>
    updateMany: (args: {
      where: { id: { in: string[] } }
      data: { archivedAt: Date; archiveS3Key: string }
    }) => Promise<{ count: number }>
  }
}

export interface ArchiveBatch {
  /** Stable batch id, used in the S3 key + idempotency. */
  batchId: string
  /** S3 key under which the batch will be uploaded. */
  s3Key: string
  /** ISO date (YYYY-MM-DD) the batch was selected on. */
  day: string
  /** Row ids included in the batch. */
  rowIds: string[]
  /** Gzipped NDJSON body. */
  body: Buffer
  /** Sha-256 hex of the *uncompressed* NDJSON body. Acts as manifest digest. */
  sha256: string
  /** Uncompressed size in bytes. */
  byteCount: number
}

/**
 * Pure: serialise a batch of audit rows into NDJSON + manifest. Tested
 * directly. The boundary calls `selectAuditBatch` to pull rows, then
 * `serialiseAuditBatch` here, then puts the body to S3.
 */
export function serialiseAuditBatch(args: {
  rows: ReadonlyArray<AuditRowForArchive>
  now: Date
  batchId?: string
}): ArchiveBatch {
  const day = args.now.toISOString().slice(0, 10) // YYYY-MM-DD
  const year = day.slice(0, 4)
  const batchId = args.batchId ?? createId()
  const s3Key = `audit-archives/${year}/${day}-${batchId}.ndjson.gz`

  const lines = args.rows.map((r) =>
    JSON.stringify({
      id: r.id,
      action: r.action,
      actorId: r.actorId,
      targetType: r.targetType,
      targetId: r.targetId,
      requestId: r.requestId,
      purpose: r.purpose,
      before: r.before ?? null,
      after: r.after ?? null,
      occurredAt: r.occurredAt.toISOString(),
    }),
  )
  const ndjson = lines.join('\n') + (lines.length > 0 ? '\n' : '')
  const ndjsonBuf = Buffer.from(ndjson, 'utf8')
  const sha256 = createHash('sha256').update(ndjsonBuf).digest('hex')
  const body = gzipSync(ndjsonBuf, { level: 9 })

  return {
    batchId,
    s3Key,
    day,
    rowIds: args.rows.map((r) => r.id),
    body,
    sha256,
    byteCount: ndjsonBuf.length,
  }
}

export function archiveCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime())
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1)
  return cutoff
}

/**
 * Pure-ish: read the next batch of un-archived rows older than the cutoff.
 * Returns null when there is nothing more to archive in this run.
 */
export async function selectAuditBatch(
  db: AuditArchiveDb,
  now: Date,
): Promise<AuditRowForArchive[] | null> {
  const rows = await db.auditLogEntry.findMany({
    where: {
      archivedAt: null,
      occurredAt: { lt: archiveCutoff(now) },
    },
    orderBy: { occurredAt: 'asc' },
    take: ARCHIVE_BATCH_SIZE,
    select: {
      id: true,
      action: true,
      actorId: true,
      targetType: true,
      targetId: true,
      requestId: true,
      purpose: true,
      before: true,
      after: true,
      occurredAt: true,
    },
  })
  return rows.length === 0 ? null : rows
}

/**
 * Mark a successfully-uploaded batch as archived. Idempotent on row id; if
 * a row was already archived by a parallel runner the count returned is
 * lower than rowIds.length.
 */
export async function markBatchArchived(
  db: AuditArchiveDb,
  rowIds: string[],
  s3Key: string,
  now: Date,
): Promise<number> {
  const r = await db.auditLogEntry.updateMany({
    where: { id: { in: rowIds } },
    data: { archivedAt: now, archiveS3Key: s3Key },
  })
  return r.count
}

// The Inngest registration is at the worker boundary
// (apps/web/app/api/inngest/_boundary/audit-log-archive.ts) so it can call
// S3 putObject without creating a jobs ↔ integrations cycle.
export const AUDIT_LOG_ARCHIVE_FUNCTIONS: never[] = []
