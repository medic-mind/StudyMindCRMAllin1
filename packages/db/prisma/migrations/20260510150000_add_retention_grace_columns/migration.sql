-- Audit-A3: retention grace + deputy-DSL escalation columns. CLAUDE.md §21, §42.2.
--
-- Adds soft-delete grace columns to Interaction and Lead so the retention
-- engine can mark rows for deletion 30 days before the hard sweep, plus a
-- conversion marker on Lead so non-converted marketing leads age out at
-- 12 months. Adds SLA acknowledgement + escalation columns to
-- SafeguardingFlag for the deputy-DSL re-page workflow.

-- Interaction: retention grace columns + sweep index.
ALTER TABLE "Interaction" ADD COLUMN IF NOT EXISTS "softDeletedAt" TIMESTAMP(3);
ALTER TABLE "Interaction" ADD COLUMN IF NOT EXISTS "pendingHardDeleteAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Interaction_pendingHardDeleteAt_idx" ON "Interaction"("pendingHardDeleteAt");

-- Lead: retention grace + conversion marker + sweep index.
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "convertedAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "softDeletedAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "pendingHardDeleteAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Lead_pendingHardDeleteAt_idx" ON "Lead"("pendingHardDeleteAt");

-- Backfill: existing leads with a convertedToContactId get convertedAt = createdAt
-- so they are not falsely aged out as "never converted".
UPDATE "Lead"
   SET "convertedAt" = "createdAt"
 WHERE "convertedToContactId" IS NOT NULL
   AND "convertedAt" IS NULL;

-- SafeguardingFlag: SLA acknowledgement + escalation tracking (CLAUDE.md §42.2).
ALTER TABLE "SafeguardingFlag" ADD COLUMN IF NOT EXISTS "acknowledgedAt" TIMESTAMP(3);
ALTER TABLE "SafeguardingFlag" ADD COLUMN IF NOT EXISTS "escalatedAt" TIMESTAMP(3);
ALTER TABLE "SafeguardingFlag" ADD COLUMN IF NOT EXISTS "escalatedToUserId" TEXT;
CREATE INDEX IF NOT EXISTS "SafeguardingFlag_escalatedAt_idx" ON "SafeguardingFlag"("escalatedAt");
