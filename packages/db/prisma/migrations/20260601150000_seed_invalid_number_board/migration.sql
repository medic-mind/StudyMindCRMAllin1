-- Seed an "Invalid number" board so the default board's "Invalid
-- number" quick action has somewhere to send cards. Also seeds the
-- "Never answered (Called 3x)" quick action targeting the existing
-- Never answered stage.
--
-- Forward-only (CLAUDE.md §19). All inserts are idempotent on stable
-- seed ids.

-- 1. Create the dedicated Invalid number board if it doesn't already
-- exist. Position is `MAX(position) + 1` over active boards so a manual
-- reorder later doesn't collide.
INSERT INTO "Board" ("id", "name", "description", "position", "isDefault", "updatedAt")
SELECT
  'board_seed_invalid_number',
  'Invalid number',
  'Cards routed here from any board when the contact has an invalid phone number. Triage and re-route from this kanban.',
  COALESCE((SELECT MAX("position") FROM "Board" WHERE "archivedAt" IS NULL), 0) + 1,
  false,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "Board" WHERE "id" = 'board_seed_invalid_number'
);

-- 2. Seed three default stages on the Invalid number board:
--   1. Needs triage         (where new arrivals land)
--   2. Confirmed invalid    (number really is dead)
--   3. Re-contact requested (someone is chasing a corrected number)
INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "boardId", "updatedAt")
VALUES
  ('pstg_seed_inv_triage',    'Needs triage',         1, 'rose-500',   false, 'board_seed_invalid_number', CURRENT_TIMESTAMP),
  ('pstg_seed_inv_confirmed', 'Confirmed invalid',    2, 'neutral-500', true,  'board_seed_invalid_number', CURRENT_TIMESTAMP),
  ('pstg_seed_inv_recontact', 'Re-contact requested', 3, 'amber-500',  false, 'board_seed_invalid_number', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name"       = EXCLUDED."name",
      "color"      = EXCLUDED."color",
      "isClosed"   = EXCLUDED."isClosed",
      "boardId"    = EXCLUDED."boardId",
      "archivedAt" = NULL,
      "updatedAt"  = CURRENT_TIMESTAMP;

-- 3. Two more quick-action chips on the default board:
--    - "Never answered (Called 3x)" → pstg_seed_not_answered (same board)
--    - "Invalid number"             → pstg_seed_inv_triage  (cross-board)
INSERT INTO "BoardQuickAction" ("id", "boardId", "label", "color",
    "targetStageId", "targetBoardId", "commentTemplate", "sortOrder",
    "updatedAt")
VALUES
  ('bqa_seed_never_answered_3x',
   'board_seed_default',
   'Never answered (Called 3x)',
   '#dc2626',
   'pstg_seed_not_answered',
   NULL,
   'Called three times — no answer. Marking as never answered.',
   40,
   CURRENT_TIMESTAMP),
  ('bqa_seed_invalid_number',
   'board_seed_default',
   'Invalid number',
   '#7c3aed',
   'pstg_seed_inv_triage',
   'board_seed_invalid_number',
   'Phone number appears invalid — routing to the Invalid number board for triage.',
   50,
   CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
