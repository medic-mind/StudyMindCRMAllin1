-- Move "Never answered" out of the Sales Pipeline into its own board (operator
-- request, 2026-07), mirroring the "Call completed" → "Completed Calls" move
-- (20260720130000). The "Never answered" quick-action chip stays on the Sales
-- Pipeline cards but now routes the card CROSS-BOARD to the new board (ADR 0018
-- cross-board routing already exists), and the "Never answered" column is
-- removed from the Sales Pipeline.
--
-- All DATA (Board / PipelineStage / BoardQuickAction rows): after this runs an
-- operator can re-point the chip, rename the board, add columns, or
-- archive/restore any of it from /boards/[id]/settings — nothing is hardcoded.
-- Forward-only + idempotent (guards on the seed ids).

-- 1. The Never answered board.
INSERT INTO "Board" ("id", "name", "description", "position", "isDefault", "updatedAt")
SELECT
  'board_seed_never_answered',
  'Never answered',
  'Leads we called but never reached — moved here off the Sales Pipeline by the "Never answered" action. Reconfigurable from board settings.',
  COALESCE((SELECT MAX("position") FROM "Board" WHERE "archivedAt" IS NULL), 0) + 1,
  false,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "Board" WHERE "id" = 'board_seed_never_answered'
);

-- 2. A "Never answered" stage on it (the landing column for the chip).
INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "boardId", "updatedAt")
VALUES
  ('pstg_seed_na_never_answered', 'Never answered', 1, 'rose-500', false, 'board_seed_never_answered', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name"       = EXCLUDED."name",
      "color"      = EXCLUDED."color",
      "boardId"    = EXCLUDED."boardId",
      "archivedAt" = NULL,
      "updatedAt"  = CURRENT_TIMESTAMP;

-- 3. Relocate any live cards on the old Sales-Pipeline "Never answered" column
--    onto the new board's stage, with fresh 1-based positions (must run BEFORE
--    archiving the old stage so no card is orphaned).
UPDATE "Card" c
   SET "stageId"   = 'pstg_seed_na_never_answered',
       "boardId"   = 'board_seed_never_answered',
       "position"  = sub.rn,
       "updatedAt" = CURRENT_TIMESTAMP
  FROM (
    SELECT "id", ROW_NUMBER() OVER (ORDER BY "position", "id") AS rn
      FROM "Card"
     WHERE "stageId" = 'pstg_seed_not_answered' AND "archivedAt" IS NULL
  ) sub
 WHERE c."id" = sub."id";

-- 4. Archive the old "Never answered" column on the Sales Pipeline (soft,
--    reversible). board.stages.list filters archivedAt IS NULL, so it
--    disappears from the Sales Pipeline board.
UPDATE "PipelineStage"
   SET "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'pstg_seed_not_answered' AND "archivedAt" IS NULL;

-- 5. Re-point (and relabel) the existing "Never answered" quick-action chip at
--    the new board's stage (cross-board). UPDATE the existing row so operator
--    colour/comment edits are preserved; this is the exact (targetStageId,
--    targetBoardId) pair the tRPC layer writes for a cross-board action.
UPDATE "BoardQuickAction"
   SET "label"         = 'Never answered',
       "targetStageId" = 'pstg_seed_na_never_answered',
       "targetBoardId" = 'board_seed_never_answered',
       "updatedAt"     = CURRENT_TIMESTAMP
 WHERE "id" = 'bqa_seed_never_answered_3x';
