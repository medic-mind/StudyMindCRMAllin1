-- Audit-B2 Chunk 3: Allocation soft-delete + idempotency.
-- CLAUDE.md §6.3 — manual allocation overrides are audit-logged. Soft-delete
-- keeps the historical row; the unique constraint is partial (only active rows)
-- so deleting and re-allocating the same (paymentId, bookingId) pair works.

ALTER TABLE "Allocation" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "Allocation" ADD COLUMN IF NOT EXISTS "reason" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Allocation_paymentId_bookingId_active_key"
  ON "Allocation" ("paymentId", "bookingId")
  WHERE "deletedAt" IS NULL;
