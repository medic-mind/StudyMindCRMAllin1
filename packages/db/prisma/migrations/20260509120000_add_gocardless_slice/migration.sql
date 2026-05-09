-- Add GoCardless slice columns and MandateIntent table.
-- See CLAUDE.md §9 (late-failure reversal) and §17.1 (recurring late-failure reconcile).

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "revertedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MandateIntent" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "billingContactId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "redirectFlowId" TEXT,
    "redirectUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "gcMandateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "MandateIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MandateIntent_idempotencyKey_key" ON "MandateIntent"("idempotencyKey");
CREATE INDEX "MandateIntent_familyId_idx" ON "MandateIntent"("familyId");
CREATE INDEX "MandateIntent_billingContactId_idx" ON "MandateIntent"("billingContactId");
CREATE INDEX "MandateIntent_status_idx" ON "MandateIntent"("status");

-- Index used by the recurring late-failure reconcile job.
CREATE INDEX "Payment_provider_confirmedAt_idx" ON "Payment"("provider", "confirmedAt");
