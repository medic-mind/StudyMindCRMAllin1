-- Move "Call completed" out of the Sales Pipeline into its own "Completed
-- Calls" board (operator request, 2026-07). The "Call completed" quick-action
-- chip stays on the Sales Pipeline cards, but now routes the card CROSS-BOARD
-- to the Completed Calls board (cross-board routing already exists, ADR 0018),
-- and the "Call completed" column is removed from the Sales Pipeline.
--
-- Everything below is DATA (Board / PipelineStage / BoardQuickAction rows), so
-- after this runs an operator can re-point the chip, rename the board, add
-- columns, or archive/restore any of it from /boards/[id]/settings — nothing
-- is hardcoded. Forward-only + idempotent (guards on the seed ids).

-- 1. The Completed Calls board.
INSERT INTO "Board" ("id", "name", "description", "position", "isDefault", "updatedAt")
SELECT
  'board_seed_completed_calls',
  'Completed Calls',
  'Calls that have been completed — moved here off the Sales Pipeline by the "Call completed" action. Reconfigurable from board settings.',
  COALESCE((SELECT MAX("position") FROM "Board" WHERE "archivedAt" IS NULL), 0) + 1,
  false,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "Board" WHERE "id" = 'board_seed_completed_calls'
);

-- 2. A "Completed" stage on it (the landing column for the chip).
INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "boardId", "updatedAt")
VALUES
  ('pstg_seed_cc_completed', 'Completed', 1, 'emerald-500', false, 'board_seed_completed_calls', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name"       = EXCLUDED."name",
      "color"      = EXCLUDED."color",
      "boardId"    = EXCLUDED."boardId",
      "archivedAt" = NULL,
      "updatedAt"  = CURRENT_TIMESTAMP;

-- 3. Relocate any live cards currently sitting on the old Sales-Pipeline
--    "Call completed" column onto the new board's "Completed" stage, with fresh
--    1-based positions (a stage's cards must not be orphaned when it archives).
UPDATE "Card" c
   SET "stageId"   = 'pstg_seed_cc_completed',
       "boardId"   = 'board_seed_completed_calls',
       "position"  = sub.rn,
       "updatedAt" = CURRENT_TIMESTAMP
  FROM (
    SELECT "id", ROW_NUMBER() OVER (ORDER BY "position", "id") AS rn
      FROM "Card"
     WHERE "stageId" = 'pstg_seed_call_completed' AND "archivedAt" IS NULL
  ) sub
 WHERE c."id" = sub."id";

-- 4. Archive the old "Call completed" column on the Sales Pipeline (soft,
--    reversible, forward-only). board.stages.list filters archivedAt IS NULL,
--    so the column disappears from the Sales Pipeline board.
UPDATE "PipelineStage"
   SET "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'pstg_seed_call_completed' AND "archivedAt" IS NULL;

-- 5. Re-point the existing "Call completed" quick-action chip at the new board's
--    stage (cross-board). We UPDATE the existing row (not create a new one) so
--    any operator colour/label/comment edits are preserved. This is the exact
--    (targetStageId, targetBoardId) pair the tRPC layer writes for a cross-board
--    action, so it stays consistent with UI edits.
UPDATE "BoardQuickAction"
   SET "targetStageId" = 'pstg_seed_cc_completed',
       "targetBoardId" = 'board_seed_completed_calls',
       "updatedAt"     = CURRENT_TIMESTAMP
 WHERE "id" = 'bqa_seed_call_completed';
