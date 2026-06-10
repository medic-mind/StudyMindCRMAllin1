-- Backfill colours on the seeded board quick-action buttons (board-UX bug
-- report: "cards lose colours"). Earlier versions of the seed migrations ran
-- before the colour values were added; ON CONFLICT DO NOTHING then preserved
-- the colourless rows, so the chips rendered grey. Idempotent: only touches
-- the five seed ids, and only where colour is still NULL — an admin-chosen
-- colour is never overwritten.

UPDATE "BoardQuickAction" SET "color" = '#f59e0b', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'bqa_seed_called_once' AND "color" IS NULL;
UPDATE "BoardQuickAction" SET "color" = '#f97316', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'bqa_seed_called_twice' AND "color" IS NULL;
UPDATE "BoardQuickAction" SET "color" = '#10b981', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'bqa_seed_call_completed' AND "color" IS NULL;
UPDATE "BoardQuickAction" SET "color" = '#dc2626', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'bqa_seed_never_answered_3x' AND "color" IS NULL;
UPDATE "BoardQuickAction" SET "color" = '#7c3aed', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'bqa_seed_invalid_number' AND "color" IS NULL;
