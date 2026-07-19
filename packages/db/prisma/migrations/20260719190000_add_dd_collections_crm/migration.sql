-- Direct Debit collections CRM (ADR 0045 amendment). Three additions, all
-- forward-only + nullable so no deploy blocks:
--   1. DirectDebitCase.personName — a standalone chase case (someone not in the
--      CRM as a Contact) carries its own display name.
--   2. DdRecoveryTemplate PDF attachment — the "letter before action" document
--      the team already sends, stored inline (same as CallSummaryTemplate).
--   3. ReconciliationDiscrepancy.issueDate — the underlying event date, so the
--      dashboard "Needs attention" queue can hide historic pre-go-live issues.

ALTER TABLE "DirectDebitCase" ADD COLUMN "personName" TEXT;

ALTER TABLE "DdRecoveryTemplate"
  ADD COLUMN "pdfFileName" TEXT,
  ADD COLUMN "pdfContentType" TEXT,
  ADD COLUMN "pdfByteSize" INTEGER,
  ADD COLUMN "pdfData" BYTEA;

ALTER TABLE "ReconciliationDiscrepancy" ADD COLUMN "issueDate" TIMESTAMP(3);

CREATE INDEX "ReconciliationDiscrepancy_issueDate_idx"
  ON "ReconciliationDiscrepancy"("issueDate");
