-- Slice 10: Tender pipeline, LAContract workflow, LAInvoice flow,
-- progress reports, AP placements, AI tender drafting + signoff.
-- See CLAUDE.md §43 and the per-section comments below.

-- 1) Append new InteractionType enum values (CLAUDE.md §19 — append-only).
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'tender_draft_signed_off';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'lacontract_created';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'lacontract_invoice_generated';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'lacontract_invoice_sent';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'lacontract_invoice_paid';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'lacontract_progress_report_signed';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'ap_review_overdue';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'tutor_session_note';

-- 2) Append new ReconciliationCategory enum value.
ALTER TYPE "ReconciliationCategory" ADD VALUE IF NOT EXISTS 'la_family_with_card_subscription';

-- 3) Tender — additional columns.
ALTER TABLE "Tender"
    ADD COLUMN "commissioner" TEXT,
    ADD COLUMN "opportunityRef" TEXT,
    ADD COLUMN "accountLeadId" TEXT,
    ADD COLUMN "dueAt" TIMESTAMP(3),
    ADD COLUMN "isSemhOrEhcpHeavy" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "outcome" TEXT,
    ADD COLUMN "outcomeReason" TEXT;

CREATE INDEX "Tender_accountLeadId_idx" ON "Tender"("accountLeadId");

-- 4) Interaction — tenderId + laContractId nullable FKs.
ALTER TABLE "Interaction"
    ADD COLUMN "tenderId" TEXT,
    ADD COLUMN "laContractId" TEXT;

CREATE INDEX "Interaction_tenderId_occurredAt_idx"
    ON "Interaction"("tenderId", "occurredAt");
CREATE INDEX "Interaction_laContractId_occurredAt_idx"
    ON "Interaction"("laContractId", "occurredAt");

-- 5) TenderDraftRequest — AI drafts under signoff.
CREATE TABLE "TenderDraftRequest" (
    "id" TEXT NOT NULL,
    "tenderId" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "sectionsToDraft" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "draftText" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "signoffState" TEXT NOT NULL DEFAULT 'pending',
    "requesterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "TenderDraftRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TenderDraftRequest_tenderId_idx" ON "TenderDraftRequest"("tenderId");
CREATE INDEX "TenderDraftRequest_signoffState_idx" ON "TenderDraftRequest"("signoffState");

-- 6) LAContract — extra columns for billing cadence, reporting cadence,
--    account lead, retention override.
ALTER TABLE "LAContract"
    ADD COLUMN "commissioner" TEXT,
    ADD COLUMN "billingCadence" TEXT NOT NULL DEFAULT 'monthly',
    ADD COLUMN "reportingCadence" TEXT NOT NULL DEFAULT 'monthly',
    ADD COLUMN "accountLeadId" TEXT,
    ADD COLUMN "retentionPolicyId" TEXT;

CREATE INDEX "LAContract_retentionPolicyId_idx" ON "LAContract"("retentionPolicyId");

-- 7) LAInvoice — state machine columns + PO number + period.
ALTER TABLE "LAInvoice"
    ADD COLUMN "familyId" TEXT,
    ADD COLUMN "state" TEXT NOT NULL DEFAULT 'draft',
    ADD COLUMN "periodStart" TIMESTAMP(3),
    ADD COLUMN "periodEnd" TIMESTAMP(3),
    ADD COLUMN "poNumber" TEXT,
    ADD COLUMN "paymentReference" TEXT,
    ADD COLUMN "sentAt" TIMESTAMP(3);

CREATE INDEX "LAInvoice_familyId_idx" ON "LAInvoice"("familyId");
CREATE INDEX "LAInvoice_state_idx" ON "LAInvoice"("state");

-- 8) LAProgressReport.
CREATE TABLE "LAProgressReport" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "draftText" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "signedById" TEXT,
    "signedAt" TIMESTAMP(3),
    "pdfS3Key" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "LAProgressReport_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LAProgressReport_contractId_familyId_periodStart_periodEnd_key"
    ON "LAProgressReport"("contractId", "familyId", "periodStart", "periodEnd");
CREATE INDEX "LAProgressReport_state_idx" ON "LAProgressReport"("state");
CREATE INDEX "LAProgressReport_familyId_idx" ON "LAProgressReport"("familyId");

-- 9) APPlacement.
CREATE TABLE "APPlacement" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "apStartDate" TIMESTAMP(3) NOT NULL,
    "apReviewDate" TIMESTAMP(3) NOT NULL,
    "apEndDate" TIMESTAMP(3),
    "statutoryReason" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "APPlacement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "APPlacement_familyId_key" ON "APPlacement"("familyId");
CREATE INDEX "APPlacement_reviewStatus_idx" ON "APPlacement"("reviewStatus");
CREATE INDEX "APPlacement_apReviewDate_idx" ON "APPlacement"("apReviewDate");

-- 10) Family — apPlacement JSONB summary.
ALTER TABLE "Family" ADD COLUMN "apPlacement" JSONB;

-- 11) Foreign keys.
ALTER TABLE "Interaction"
    ADD CONSTRAINT "Interaction_tenderId_fkey"
    FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Interaction"
    ADD CONSTRAINT "Interaction_laContractId_fkey"
    FOREIGN KEY ("laContractId") REFERENCES "LAContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TenderDraftRequest"
    ADD CONSTRAINT "TenderDraftRequest_tenderId_fkey"
    FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LAProgressReport"
    ADD CONSTRAINT "LAProgressReport_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "LAContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
