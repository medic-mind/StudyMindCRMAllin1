-- ADR 0018: multi-board cards.
--
-- Generalises the single dynamic pipeline (ADR 0015) into multiple boards,
-- each owning its own PipelineStages and Cards. A Card is backed by a Contact
-- (lighter than a Family, which remains the billing unit). The legacy
-- `Family.stageId` is RETAINED per CLAUDE.md §19 forward-only rule; reconcile
-- and at-risk derivations keep reading `state`/`stageId`. Cards are the new
-- board representation.

-- 0. Append the new InteractionType enum value (Postgres enums are
-- append-only in a single migration per CLAUDE.md §19).
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'card_moved';

-- 1. Board table.
CREATE TABLE "Board" (
  "id"                TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "description"       TEXT,
  "position"          INTEGER NOT NULL,
  "isDefault"         BOOLEAN NOT NULL DEFAULT false,
  "tickActionStageId" TEXT,
  "xActionStageId"    TEXT,
  "archivedAt"        TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  "createdById"       TEXT,

  CONSTRAINT "Board_pkey" PRIMARY KEY ("id")
);

-- Only one board per position among the active (non-archived) set.
CREATE UNIQUE INDEX "Board_position_active_key"
  ON "Board" ("position")
  WHERE "archivedAt" IS NULL;

CREATE INDEX "Board_archivedAt_idx" ON "Board" ("archivedAt");

-- 2. PipelineStage gains a boardId FK (cascade so dropping a board removes its
-- stages). Nullable for backward compatibility; the data migration assigns all
-- existing stages to the default board.
ALTER TABLE "PipelineStage" ADD COLUMN "boardId" TEXT;

ALTER TABLE "PipelineStage"
  ADD CONSTRAINT "PipelineStage_boardId_fkey"
  FOREIGN KEY ("boardId") REFERENCES "Board" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "PipelineStage_boardId_idx" ON "PipelineStage" ("boardId");

-- 3. Subject table.
CREATE TABLE "Subject" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "lastUsedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT,

  CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subject_name_key" ON "Subject" ("name");

-- 4. Card table.
CREATE TABLE "Card" (
  "id"          TEXT NOT NULL,
  "boardId"     TEXT NOT NULL,
  "stageId"     TEXT NOT NULL,
  "contactId"   TEXT NOT NULL,
  "subjectId"   TEXT,
  "position"    INTEGER NOT NULL,
  "archivedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "createdById" TEXT,

  CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Card"
  ADD CONSTRAINT "Card_boardId_fkey"
  FOREIGN KEY ("boardId") REFERENCES "Board" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Card"
  ADD CONSTRAINT "Card_stageId_fkey"
  FOREIGN KEY ("stageId") REFERENCES "PipelineStage" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Card"
  ADD CONSTRAINT "Card_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Card"
  ADD CONSTRAINT "Card_subjectId_fkey"
  FOREIGN KEY ("subjectId") REFERENCES "Subject" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Card_boardId_stageId_position_idx"
  ON "Card" ("boardId", "stageId", "position");

CREATE INDEX "Card_contactId_idx" ON "Card" ("contactId");

-- 5. Label + CardLabel junction.
CREATE TABLE "Label" (
  "id"        TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "color"     TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Label_name_key" ON "Label" ("name");

CREATE TABLE "CardLabel" (
  "cardId"  TEXT NOT NULL,
  "labelId" TEXT NOT NULL,

  CONSTRAINT "CardLabel_pkey" PRIMARY KEY ("cardId", "labelId")
);

ALTER TABLE "CardLabel"
  ADD CONSTRAINT "CardLabel_cardId_fkey"
  FOREIGN KEY ("cardId") REFERENCES "Card" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CardLabel"
  ADD CONSTRAINT "CardLabel_labelId_fkey"
  FOREIGN KEY ("labelId") REFERENCES "Label" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "CardLabel_labelId_idx" ON "CardLabel" ("labelId");

-- 6. Replace the global PipelineStage position uniqueness with a per-board
-- one. The ADR-0015 index was on (position) WHERE archivedAt IS NULL; we now
-- scope it to (boardId, position) so two boards can each have a position 1.
DROP INDEX "PipelineStage_position_active_key";

CREATE UNIQUE INDEX "PipelineStage_boardId_position_active_key"
  ON "PipelineStage" ("boardId", "position")
  WHERE "archivedAt" IS NULL;

-- 7. Seed three default labels.
INSERT INTO "Label" ("id", "name", "color")
VALUES
  ('lbl_seed_b2c',         'B2C',         'blue-600'),
  ('lbl_seed_b2b',         'B2B',         'violet-600'),
  ('lbl_seed_summer_camp', 'Summer Camp', 'amber-500');

-- 8. Create the default board and adopt every existing stage onto it.
INSERT INTO "Board" ("id", "name", "description", "position", "isDefault", "updatedAt")
VALUES (
  'board_seed_default',
  'Sales Pipeline',
  'The default sales funnel (migrated from the single dynamic pipeline).',
  1,
  true,
  CURRENT_TIMESTAMP
);

UPDATE "PipelineStage" SET "boardId" = 'board_seed_default' WHERE "boardId" IS NULL;

-- 9. Ensure the default board has "Call completed" and "Not answered" stages
-- (positioned after the existing ones) if they do not already exist.
INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "boardId", "updatedAt")
SELECT
  'pstg_seed_call_completed',
  'Call completed',
  COALESCE((SELECT MAX("position") FROM "PipelineStage" WHERE "boardId" = 'board_seed_default' AND "archivedAt" IS NULL), 0) + 1,
  'sky-500',
  false,
  'board_seed_default',
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "PipelineStage"
  WHERE "boardId" = 'board_seed_default' AND lower("name") = 'call completed' AND "archivedAt" IS NULL
);

INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "boardId", "updatedAt")
SELECT
  'pstg_seed_not_answered',
  'Not answered',
  COALESCE((SELECT MAX("position") FROM "PipelineStage" WHERE "boardId" = 'board_seed_default' AND "archivedAt" IS NULL), 0) + 1,
  'slate-500',
  false,
  'board_seed_default',
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "PipelineStage"
  WHERE "boardId" = 'board_seed_default' AND lower("name") = 'not answered' AND "archivedAt" IS NULL
);

-- 10. Configure the default board's quick actions: tick → "Active" (or the
-- first non-closed stage), x → "Not answered" if present.
UPDATE "Board" b
SET "tickActionStageId" = COALESCE(
  (SELECT ps."id" FROM "PipelineStage" ps
     WHERE ps."boardId" = b."id" AND lower(ps."name") = 'active' AND ps."archivedAt" IS NULL
     LIMIT 1),
  (SELECT ps."id" FROM "PipelineStage" ps
     WHERE ps."boardId" = b."id" AND ps."isClosed" = false AND ps."archivedAt" IS NULL
     ORDER BY ps."position" ASC LIMIT 1)
)
WHERE b."id" = 'board_seed_default';

UPDATE "Board" b
SET "xActionStageId" = (
  SELECT ps."id" FROM "PipelineStage" ps
    WHERE ps."boardId" = b."id" AND lower(ps."name") = 'not answered' AND ps."archivedAt" IS NULL
    LIMIT 1
)
WHERE b."id" = 'board_seed_default';

-- 11. Backfill one Card per existing Family that has a stageId. The card's
-- contact is the family's billing contact, else the first member by join
-- order. Families with no contact at all are skipped. Position is the row
-- number within (stageId).
INSERT INTO "Card" ("id", "boardId", "stageId", "contactId", "position", "createdAt", "updatedAt")
SELECT
  'card_seed_' || f."id",
  'board_seed_default',
  f."stageId",
  fc."contactId",
  row_number() OVER (PARTITION BY f."stageId" ORDER BY f."createdAt" ASC, f."id" ASC),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Family" f
JOIN LATERAL (
  SELECT fm."contactId"
  FROM "FamilyMember" fm
  WHERE fm."familyId" = f."id"
  ORDER BY (fm."role" = 'billing') DESC, fm."createdAt" ASC
  LIMIT 1
) fc ON true
WHERE f."stageId" IS NOT NULL
  AND f."deletedAt" IS NULL;
