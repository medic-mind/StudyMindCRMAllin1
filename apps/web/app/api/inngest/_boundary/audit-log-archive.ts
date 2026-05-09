// Worker boundary: weekly AuditLogEntry archive to S3 cold storage.
// CLAUDE.md §17.1, §21.
//
// Sundays 05:00 UTC. Repeatedly:
//   1. Select up to 1000 un-archived rows older than 12 months.
//   2. Serialise to gzipped NDJSON with a SHA-256 manifest.
//   3. PUT to S3 (audit-archives/<yyyy>/<yyyy-mm-dd>-<batchId>.ndjson.gz).
//   4. UPDATE the rows' archivedAt + archiveS3Key.
// Loops until no more rows are due. The selection-then-upload-then-mark
// ordering keeps the job idempotent: a crash mid-upload leaves the rows
// un-archived and the next run picks them up.
//
// Concurrency 1 — only one archiver should run at a time. Retries 3.

import {
  ARCHIVE_BATCH_SIZE,
  markBatchArchived,
  selectAuditBatch,
  serialiseAuditBatch,
  type AuditArchiveDb,
} from '@studymind/jobs/compliance/audit-log-archive'
import { inngest } from '@studymind/jobs'
import { putAuditArchive } from '@studymind/core/observability/audit-archive-s3'

import { db } from '@/lib/db'

const MAX_BATCHES_PER_RUN = 50 // Cap a single weekly run at 50k rows.

export const auditLogArchiveWeekly = inngest.createFunction(
  {
    id: 'compliance/audit-log-archive',
    name: 'Compliance: weekly AuditLogEntry archive (boundary)',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '0 5 * * 0' },
  async ({ step, logger }) => {
    const startedAt = new Date()
    let totalRows = 0
    let batches = 0

    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const rows = await step.run(`select-${i}`, () =>
        selectAuditBatch(db as unknown as AuditArchiveDb, new Date()),
      )
      if (!rows || rows.length === 0) break

      const batch = serialiseAuditBatch({
        rows: rows.map((r) => ({ ...r, occurredAt: new Date(r.occurredAt) })),
        now: new Date(),
      })

      await step.run(`s3-put-${i}`, () =>
        putAuditArchive({
          s3Key: batch.s3Key,
          body: batch.body,
          sha256: batch.sha256,
          rowCount: batch.rowIds.length,
        }),
      )

      const marked = await step.run(`mark-${i}`, () =>
        markBatchArchived(
          db as unknown as AuditArchiveDb,
          batch.rowIds,
          batch.s3Key,
          new Date(),
        ),
      )

      totalRows += marked
      batches += 1

      logger.info(
        {
          batchId: batch.batchId,
          s3Key: batch.s3Key,
          rowCount: batch.rowIds.length,
          marked,
        },
        'audit.archive.batch_completed',
      )

      // If we got fewer than the batch size, there's nothing else to do.
      if (rows.length < ARCHIVE_BATCH_SIZE) break
    }

    logger.info(
      {
        startedAt: startedAt.toISOString(),
        totalRows,
        batches,
      },
      'audit.archive.run_completed',
    )

    return { totalRows, batches }
  },
)
