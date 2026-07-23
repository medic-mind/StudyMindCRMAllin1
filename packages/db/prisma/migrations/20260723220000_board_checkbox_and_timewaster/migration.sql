-- Board card affordances (operator request, 2026-07):
--   1. A Todoist-style tick-circle on each card that fires the "Call completed"
--      action (moves the card cross-board to the Completed Calls board). Driven
--      by a new BoardQuickAction.isCheckbox flag so an operator can re-designate
--      which action is the circle from board settings — nothing hardcoded.
--   2. A "Time waster" quick-action chip on the Sales Pipeline that moves the
--      card cross-board to a new "Time Wasters" board. Reversible: the card can
--      be moved back to Sales via the per-card Move-to dropdown (cross-board
--      moves already exist, ADR 0018).
-- Forward-only + idempotent (guards on the seed ids).

-- 1. The tick-circle flag. Existing rows default to false.
ALTER TABLE "BoardQuickAction"
  ADD COLUMN IF NOT EXISTS "isCheckbox" BOOLEAN NOT NULL DEFAULT false;

-- 2. Designate the existing "Call completed" quick action as the card
--    tick-circle. (It already routes cross-board to the Completed Calls board.)
UPDATE "BoardQuickAction"
   SET "isCheckbox" = true, "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'bqa_seed_call_completed';

-- 3. The Time Wasters board.
INSERT INTO "Board" ("id", "name", "description", "position", "isDefault", "updatedAt")
SELECT
  'board_seed_time_waster',
  'Time Wasters',
  'Cards marked as a time waster, moved here off the Sales Pipeline by the "Time waster" action. Move a card back to the Sales Pipeline any time from its Move-to menu. Reconfigurable from board settings.',
  COALESCE((SELECT MAX("position") FROM "Board" WHERE "archivedAt" IS NULL), 0) + 1,
  false,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "Board" WHERE "id" = 'board_seed_time_waster'
);

-- 4. A "Time wasters" landing stage on it.
INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "boardId", "updatedAt")
VALUES
  ('pstg_seed_tw_timewaster', 'Time wasters', 1, 'neutral-500', true, 'board_seed_time_waster', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name"       = EXCLUDED."name",
      "color"      = EXCLUDED."color",
      "boardId"    = EXCLUDED."boardId",
      "archivedAt" = NULL,
      "updatedAt"  = CURRENT_TIMESTAMP;

-- 5. The "Time waster" quick-action chip on the Sales Pipeline, routing the card
--    cross-board to the Time Wasters board.
INSERT INTO "BoardQuickAction" ("id", "boardId", "label", "color",
    "targetStageId", "targetBoardId", "commentTemplate", "isCheckbox", "sortOrder",
    "updatedAt")
VALUES
  ('bqa_seed_time_waster',
   'board_seed_default',
   'Time waster',
   '#6b7280',
   'pstg_seed_tw_timewaster',
   'board_seed_time_waster',
   'Marked as a time waster.',
   false,
   90,
   CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "targetStageId" = EXCLUDED."targetStageId",
      "targetBoardId" = EXCLUDED."targetBoardId",
      "updatedAt"     = CURRENT_TIMESTAMP;
