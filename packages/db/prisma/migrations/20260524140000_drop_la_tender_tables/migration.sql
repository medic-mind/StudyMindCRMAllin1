-- Drop LA tender + AP placement schema. ADR 0016.
--
-- These tables are orphans from the LA tender workflow that was discontinued
-- by ADR 0011 (and confirmed by ADR 0013 sales-CRM pivot). There are no
-- consumers in apps/web, packages/core, packages/jobs, or packages/integrations
-- (verified by grep at PR time). CLAUDE.md §19 allows table drops in a single
-- migration when no consumers exist.
--
-- Drop order respects FKs:
--   LAProgressReport -> LAContract
--   LAInvoice        -> LAContract
--   TenderDraftRequest -> Tender
--   Interaction.laContractId / .tenderId  (FKs only; column kept for now)
--   Family.laContractId                   (FK only; column kept for now)
--   LAContract -> Tender
--   Tender
--   APPlacement                           (no FKs)
--
-- Columns Family.laContractId, Interaction.laContractId, Interaction.tenderId,
-- and Family.apPlacement are dropped in the same migration because they too
-- have no remaining code consumers.

BEGIN;

-- 1. Drop FKs from Family and Interaction to LAContract / Tender before
-- dropping the parent tables.
ALTER TABLE "Family" DROP CONSTRAINT IF EXISTS "Family_laContractId_fkey";
ALTER TABLE "Interaction" DROP CONSTRAINT IF EXISTS "Interaction_laContractId_fkey";
ALTER TABLE "Interaction" DROP CONSTRAINT IF EXISTS "Interaction_tenderId_fkey";

-- 2. Drop indexes that reference the soon-to-be-removed columns.
DROP INDEX IF EXISTS "Family_laContractId_idx";
DROP INDEX IF EXISTS "Interaction_laContractId_occurredAt_idx";
DROP INDEX IF EXISTS "Interaction_tenderId_occurredAt_idx";

-- 3. Drop the dependent columns on Family and Interaction.
ALTER TABLE "Family" DROP COLUMN IF EXISTS "laContractId";
ALTER TABLE "Family" DROP COLUMN IF EXISTS "apPlacement";
ALTER TABLE "Interaction" DROP COLUMN IF EXISTS "laContractId";
ALTER TABLE "Interaction" DROP COLUMN IF EXISTS "tenderId";

-- 4. Drop child tables before their parents.
DROP TABLE IF EXISTS "LAProgressReport";
DROP TABLE IF EXISTS "LAInvoice";
DROP TABLE IF EXISTS "TenderDraftRequest";
DROP TABLE IF EXISTS "LAContract";
DROP TABLE IF EXISTS "Tender";
DROP TABLE IF EXISTS "APPlacement";

-- 5. Drop the TenderState enum (no remaining users).
DROP TYPE IF EXISTS "TenderState";

-- 6. Drop the deprecated ap_review_overdue value from ReconciliationCategory.
-- Postgres has no direct DROP VALUE; the safe path is to recreate the enum
-- without the value and rebind the column. No rows use the value (verified
-- at PR time); the recreate is forward-only.
ALTER TYPE "ReconciliationCategory" RENAME TO "ReconciliationCategory_old";

CREATE TYPE "ReconciliationCategory" AS ENUM (
  'hours_mismatch',
  'payment_unallocated',
  'late_failure',
  'late_failure_pending_action',
  'churned_with_active_subscription',
  'la_family_with_card_subscription',
  'other'
);

ALTER TABLE "ReconciliationDiscrepancy"
  ALTER COLUMN "category" TYPE "ReconciliationCategory"
  USING ("category"::text::"ReconciliationCategory");

DROP TYPE "ReconciliationCategory_old";

COMMIT;
