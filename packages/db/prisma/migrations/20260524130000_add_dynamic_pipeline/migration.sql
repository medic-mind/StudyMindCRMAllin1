-- Slice 3 of the sales-CRM pivot. See ADR 0015.
--
-- Replaces the hardcoded `Family.state` enum-based pipeline with a dynamic
-- `PipelineStage` table that operators can create, rename, reorder, and
-- archive. The legacy `Family.state` column is RETAINED per CLAUDE.md §19
-- forward-only rule; `moveFamily` mirrors a best-effort value into it when
-- a stage name matches an old enum value.

-- 0. Append the new InteractionType enum value. Postgres enums are
-- append-only in a single migration per CLAUDE.md §19.
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'family_pipeline_moved';

-- 1. PipelineStage table.
CREATE TABLE "PipelineStage" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "position"    INTEGER NOT NULL,
  "color"       TEXT NOT NULL,
  "isClosed"    BOOLEAN NOT NULL DEFAULT false,
  "archivedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "createdById" TEXT,

  CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- Only one stage per position among the active (non-archived) set. Archived
-- stages keep their old position untouched.
CREATE UNIQUE INDEX "PipelineStage_position_active_key"
  ON "PipelineStage" ("position")
  WHERE "archivedAt" IS NULL;

CREATE INDEX "PipelineStage_archivedAt_idx"
  ON "PipelineStage" ("archivedAt");

-- 2. Family.stageId FK to PipelineStage. SetNull on delete so an archive or
-- accidental hard-delete of a stage row never cascades into family loss.
ALTER TABLE "Family"
  ADD COLUMN "stageId" TEXT;

ALTER TABLE "Family"
  ADD CONSTRAINT "Family_stageId_fkey"
  FOREIGN KEY ("stageId") REFERENCES "PipelineStage" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Family_stageId_idx" ON "Family" ("stageId");

-- 3. Seed the five default stages mapping 1:1 to the legacy FamilyState enum
-- values. Deterministic IDs so the data migration's name-match UPDATE can
-- target them reliably even if the table is reset and re-seeded.
INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "updatedAt")
VALUES
  ('pstg_seed_lead',    'Lead',    1, 'blue-500',    false, CURRENT_TIMESTAMP),
  ('pstg_seed_trial',   'Trial',   2, 'amber-500',   false, CURRENT_TIMESTAMP),
  ('pstg_seed_active',  'Active',  3, 'emerald-500', false, CURRENT_TIMESTAMP),
  ('pstg_seed_at_risk', 'At risk', 4, 'orange-600',  false, CURRENT_TIMESTAMP),
  ('pstg_seed_churned', 'Churned', 5, 'rose-600',    true,  CURRENT_TIMESTAMP);

-- 4. Backfill `Family.stageId` from the legacy enum. Case-insensitive
-- match: turn 'at_risk' into 'At risk', 'lead' into 'Lead', etc., then
-- match against PipelineStage.name. Anything that doesn't match leaves
-- stageId NULL — that family will be invisible on the pipeline kanban
-- until an operator assigns it.
UPDATE "Family" f
SET "stageId" = ps."id"
FROM "PipelineStage" ps
WHERE ps."name" = INITCAP(REPLACE(f."state"::text, '_', ' '))
  AND f."state" IS NOT NULL;
