-- Per-lead-source board routing + an ANZ Sales Pipeline board (ADR 0023
-- amendment, operator request 2026-07).
--
-- 1) LeadSource.targetBoardId lets a Contact-Form-7 / webhook source pin its
--    leads to a board (e.g. the ANZ website → the ANZ Sales Pipeline). Nullable
--    + ON DELETE SET NULL so archiving/deleting a board never breaks a source;
--    default null = existing behaviour (the classifier decides sales vs
--    free-resources). Free-resources leads still override to the Free Resources
--    board regardless of this (enforced in process-lead.ts).
-- 2) Seed the ANZ Sales Pipeline board so it exists with a landing "New leads"
--    stage out of the box; the operator maps their ANZ LeadSource to it in
--    Settings → Integrations → Lead webhook, and can rename/recolour/add columns
--    from /boards/[id]/settings (fully customisable). Forward-only + idempotent.

-- 1. targetBoardId column + FK + index.
ALTER TABLE "LeadSource" ADD COLUMN IF NOT EXISTS "targetBoardId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'LeadSource_targetBoardId_fkey'
  ) THEN
    ALTER TABLE "LeadSource"
      ADD CONSTRAINT "LeadSource_targetBoardId_fkey"
      FOREIGN KEY ("targetBoardId") REFERENCES "Board"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "LeadSource_targetBoardId_idx" ON "LeadSource"("targetBoardId");

-- 2. The ANZ Sales Pipeline board.
INSERT INTO "Board" ("id", "name", "description", "position", "isDefault", "updatedAt")
SELECT
  'board_seed_anz_sales',
  'ANZ Sales Pipeline',
  'Sales pipeline for ANZ website enquiries. Point the ANZ Contact Form 7 lead source at this board in Settings → Integrations → Lead webhook. Reconfigurable from board settings.',
  COALESCE((SELECT MAX("position") FROM "Board" WHERE "archivedAt" IS NULL), 0) + 1,
  false,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Board" WHERE "id" = 'board_seed_anz_sales');

-- 3. Core columns (New leads is the landing stage lead routing looks for).
INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "boardId", "updatedAt")
VALUES
  ('pstg_seed_anz_new_leads',    'New leads',    1, 'blue-500',   false, 'board_seed_anz_sales', CURRENT_TIMESTAMP),
  ('pstg_seed_anz_called_once',  'Called once',  2, 'amber-500',  false, 'board_seed_anz_sales', CURRENT_TIMESTAMP),
  ('pstg_seed_anz_called_twice', 'Called twice', 3, 'orange-500', false, 'board_seed_anz_sales', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- 4. Quick-action chips mirroring the default Sales Pipeline: called once/twice
--    on-board, and cross-board "Call completed" / "Never answered" routing to
--    the shared boards created by the earlier migrations.
INSERT INTO "BoardQuickAction" ("id", "boardId", "label", "color",
    "targetStageId", "targetBoardId", "commentTemplate", "sortOrder", "updatedAt")
VALUES
  ('bqa_seed_anz_called_once',  'board_seed_anz_sales', 'Called once',  '#f59e0b',
   'pstg_seed_anz_called_once',  NULL, 'Called once — no answer / left voicemail.', 10, CURRENT_TIMESTAMP),
  ('bqa_seed_anz_called_twice', 'board_seed_anz_sales', 'Called twice', '#f97316',
   'pstg_seed_anz_called_twice', NULL, 'Called twice — no answer / left voicemail.', 20, CURRENT_TIMESTAMP),
  ('bqa_seed_anz_call_completed', 'board_seed_anz_sales', 'Call completed', '#10b981',
   'pstg_seed_cc_completed', 'board_seed_completed_calls', 'Call completed.', 30, CURRENT_TIMESTAMP),
  ('bqa_seed_anz_never_answered', 'board_seed_anz_sales', 'Never answered', '#f43f5e',
   'pstg_seed_na_never_answered', 'board_seed_never_answered', 'Never answered.', 40, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
