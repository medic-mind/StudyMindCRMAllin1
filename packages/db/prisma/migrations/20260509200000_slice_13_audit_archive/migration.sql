-- Slice 13: AuditLogEntry archive metadata + index for the cold-storage scan.
-- CLAUDE.md §17.1, §21.

ALTER TABLE "AuditLogEntry" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "AuditLogEntry" ADD COLUMN "archiveS3Key" TEXT;

-- Scan: rows older than 12 months that are not yet archived. The composite
-- index is selective on `archivedAt IS NULL` because most rows are not yet
-- archived; the secondary `occurredAt` ordering keeps the batched scan
-- monotonic.
CREATE INDEX "AuditLogEntry_archivedAt_occurredAt_idx"
  ON "AuditLogEntry" ("archivedAt", "occurredAt");
