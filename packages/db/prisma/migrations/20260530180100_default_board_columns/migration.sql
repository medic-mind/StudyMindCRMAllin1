-- Default sales board columns + seed quick actions. The operator-managed
-- pipeline can be edited freely from /pipeline/manage afterwards — these
-- seeds give the board the user's preferred starting layout.
--
-- Forward-only (CLAUDE.md §19). Legacy lifecycle stages are archived
-- (soft-flag) rather than deleted, so Family.stageId references stay
-- valid and stages can be restored if needed.
--
-- This migration is fully self-healing: it tolerates any prior state
-- (including a previous half-applied attempt of itself) because:
--   1. It first parks ALL active stages on the default board at high
--      sentinel positions (current + 1000). That frees positions 1-8
--      regardless of what was there.
--   2. It then UPSERTs the target stage set with the correct positions.
--   3. It re-positions the keepers (call_completed, not_answered) at
--      the end.
-- Every step is idempotent against the partial unique index
-- (boardId, position) WHERE archivedAt IS NULL.

-- 1. Rename the legacy "Not answered" stage to "Never answered" — matches
-- the user's preferred wording. No-op if the row was already renamed
-- (or if it never existed).
UPDATE "PipelineStage"
   SET "name" = 'Never answered', "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'pstg_seed_not_answered'
   AND "name" = 'Not answered';

-- 2. Archive the legacy lifecycle stages on the default board so the
-- kanban starts clean. Forward-only — `pipeline.stage.restore` brings them
-- back at any time. No-op for stages already archived.
UPDATE "PipelineStage"
   SET "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
 WHERE "boardId" = 'board_seed_default'
   AND "id" IN (
     'pstg_seed_lead',
     'pstg_seed_trial',
     'pstg_seed_active',
     'pstg_seed_at_risk',
     'pstg_seed_churned'
   )
   AND "archivedAt" IS NULL;

-- 3. Park every remaining ACTIVE stage on the default board at a high
-- sentinel position (current + 1000). This guarantees positions 1-8
-- are free no matter what's there — including any partial inserts left
-- over from a previous failed run of this migration. Adding the SAME
-- constant 1000 to every row preserves their relative order without
-- creating new collisions.
UPDATE "PipelineStage"
   SET "position" = "position" + 1000, "updatedAt" = CURRENT_TIMESTAMP
 WHERE "boardId" = 'board_seed_default'
   AND "archivedAt" IS NULL
   AND "position" < 1000;

-- 4. UPSERT the user's preferred columns to their target positions.
-- Using ON CONFLICT (id) DO UPDATE so rows that already exist (from a
-- partial earlier attempt) get re-pointed at the correct position +
-- boardId + name. Rows that don't exist get inserted fresh. Either way
-- the final state is the same six-stage set.
INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "boardId", "updatedAt")
VALUES
  ('pstg_seed_new_leads',         'New leads',          1, 'blue-500',    false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_scheduled_9_1',     'Scheduled 9am-1pm',  2, 'violet-500',  false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_scheduled_1_4',     'Scheduled 1pm-4pm',  3, 'fuchsia-500', false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_scheduled_4_8',     'Scheduled 4pm-8pm',  4, 'pink-500',    false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_called_once',       'Called once',        5, 'amber-500',   false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_called_twice',      'Called twice',       6, 'orange-500',  false, 'board_seed_default', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name"       = EXCLUDED."name",
      "position"   = EXCLUDED."position",
      "color"      = EXCLUDED."color",
      "isClosed"   = EXCLUDED."isClosed",
      "boardId"    = EXCLUDED."boardId",
      "archivedAt" = NULL,
      "updatedAt"  = CURRENT_TIMESTAMP;

-- 5. Re-position the existing Never answered + Call completed at the
-- end of the board, after the new columns. They're currently parked at
-- 1006 + 1007 (from step 3). Move them back to 7 + 8.
UPDATE "PipelineStage" SET "position" = 7, "boardId" = 'board_seed_default',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'pstg_seed_not_answered';
UPDATE "PipelineStage" SET "position" = 8, "boardId" = 'board_seed_default',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'pstg_seed_call_completed';

-- 6. Seed the three quick-action buttons the user wanted. Each button
-- adds a templated comment and moves the card to the named stage.
-- Editable from board settings; archive any that are no longer useful.
INSERT INTO "BoardQuickAction" ("id", "boardId", "label", "color",
    "targetStageId", "targetBoardId", "commentTemplate", "sortOrder",
    "updatedAt")
VALUES
  ('bqa_seed_called_once',
   'board_seed_default',
   'Called once',
   '#f59e0b',
   'pstg_seed_called_once',
   NULL,
   'Called once — no answer / left voicemail.',
   10,
   CURRENT_TIMESTAMP),
  ('bqa_seed_called_twice',
   'board_seed_default',
   'Called twice',
   '#f97316',
   'pstg_seed_called_twice',
   NULL,
   'Called twice — no answer / left voicemail.',
   20,
   CURRENT_TIMESTAMP),
  ('bqa_seed_call_completed',
   'board_seed_default',
   'Call completed',
   '#10b981',
   'pstg_seed_call_completed',
   NULL,
   'Call completed.',
   30,
   CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- 7. Clear the legacy tick/X pointers on the default board — the
-- multi-row BoardQuickAction catalogue takes over rendering.
UPDATE "Board"
   SET "tickActionStageId" = NULL,
       "xActionStageId"    = NULL,
       "updatedAt"         = CURRENT_TIMESTAMP
 WHERE "id" = 'board_seed_default';
