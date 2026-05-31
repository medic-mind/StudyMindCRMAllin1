-- B2B Invoices Platform backfill → real School / B2B Partner accounts.
-- When a b2b customer is imported and the auto-classifier can't confidently
-- decide school vs B2B partner, the account is flagged for the "Unsorted" tray
-- with one-click classify buttons. Additive + nullable — forward-only
-- (CLAUDE.md §19).

ALTER TABLE "BusinessAccount"
  ADD COLUMN "needsClassification" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "classificationReason" TEXT,
  ADD COLUMN "classificationConfidence" DOUBLE PRECISION;

CREATE INDEX "BusinessAccount_needsClassification_idx"
  ON "BusinessAccount"("needsClassification");
