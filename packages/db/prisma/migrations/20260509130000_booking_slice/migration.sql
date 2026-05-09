-- Slice 4: Booking sync + reconciliation engine.
-- See CLAUDE.md §6.3 (reconciliation triangle), §15 (booking site source of
-- truth for hours), §41.2 (allocation invariants).

-- Family: track the last successful booking sync per family so the recurring
-- pull can ask the booking site only for changes since that point.
ALTER TABLE "Family" ADD COLUMN "lastBookingSyncAt" TIMESTAMP(3);

-- BookingSession: extend to mirror the booking-site fields directly.
-- `hours` is retained for backwards compatibility with existing seed and is
-- maintained in sync by the upsert path.
ALTER TABLE "BookingSession" ADD COLUMN "externalId" TEXT;
ALTER TABLE "BookingSession" ADD COLUMN "contractedHours" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BookingSession" ADD COLUMN "scheduledHours" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BookingSession" ADD COLUMN "deliveredHours" INTEGER NOT NULL DEFAULT 0;

-- New rows must have an externalId; backfill is a no-op for empty tables.
UPDATE "BookingSession" SET "externalId" = 'legacy_' || "id" WHERE "externalId" IS NULL;
ALTER TABLE "BookingSession" ALTER COLUMN "externalId" SET NOT NULL;
CREATE UNIQUE INDEX "BookingSession_externalId_key" ON "BookingSession"("externalId");

-- ReconciliationCategory: append-only enum addition (CLAUDE.md §19 enum rules).
ALTER TYPE "ReconciliationCategory" ADD VALUE IF NOT EXISTS 'late_failure_pending_action';
ALTER TYPE "ReconciliationCategory" ADD VALUE IF NOT EXISTS 'churned_with_active_subscription';

-- ReconciliationDiscrepancy: contextHash makes the nightly reconcile idempotent.
-- Two runs that compute the same discrepancy for the same family should not
-- create two rows. CLAUDE.md §17 (idempotency) and §6.3.
ALTER TABLE "ReconciliationDiscrepancy" ADD COLUMN "contextHash" TEXT;
UPDATE "ReconciliationDiscrepancy" SET "contextHash" = 'legacy_' || "id" WHERE "contextHash" IS NULL;
ALTER TABLE "ReconciliationDiscrepancy" ALTER COLUMN "contextHash" SET NOT NULL;
CREATE UNIQUE INDEX "ReconciliationDiscrepancy_familyId_category_contextHash_key"
  ON "ReconciliationDiscrepancy"("familyId", "category", "contextHash");
