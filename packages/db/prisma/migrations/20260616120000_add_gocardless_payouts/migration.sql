-- ADR 0038 (parity pass 2): GoCardless payouts mirror + the payment → payout
-- link, powering the Payouts tab and per-payout drill-down. Forward-only:
-- additive table + nullable column.

ALTER TABLE "GcPayment" ADD COLUMN "gcPayoutId" TEXT;
CREATE INDEX "GcPayment_gcPayoutId_idx" ON "GcPayment"("gcPayoutId");

CREATE TABLE "GcPayout" (
    "id" TEXT NOT NULL,
    "gcPayoutId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "deductedFeesMinor" INTEGER,
    "reference" TEXT,
    "payoutType" TEXT,
    "arrivalDate" TIMESTAMP(3),
    "gcCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "GcPayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GcPayout_gcPayoutId_key" ON "GcPayout"("gcPayoutId");
CREATE INDEX "GcPayout_status_idx" ON "GcPayout"("status");
CREATE INDEX "GcPayout_arrivalDate_idx" ON "GcPayout"("arrivalDate");
