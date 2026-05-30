-- Default sales board columns + seed quick actions. The operator-managed
-- pipeline can be edited freely from /pipeline/manage afterwards — these
-- seeds give the board the user's preferred starting layout.
--
-- Forward-only (CLAUDE.md §19). Legacy lifecycle stages are archived
-- (soft-flag) rather than deleted, so Family.stageId references stay
-- valid and stages can be restored if needed.
--
-- This migration is fully self-healing — it tolerates any prior state
-- (including a previous half-applied attempt of itself) because:
--
--   1. It first parks ALL active stages on the default board at high
--      sentinel positions (current + 1000) by RANGE, not by id. That
--      frees positions 1-8 regardless of what was there. The `< 1000`
--      guard makes the step idempotent across re-runs.
--   2. It then UPSERTs the complete target stage set — the six new
--      columns AT 1-6, plus pstg_seed_not_answered AT 7 and
--      pstg_seed_call_completed AT 8. Earlier deploys of the original
--      board-seed migration used a conditional INSERT that only created
--      the call-completed / not-answered rows when no stage of that
--      name was already present; some environments therefore have
--      neither id at all, so the BoardQuickAction FKs below need both
--      ids to be guaranteed present. UPSERT (ON CONFLICT DO UPDATE)
--      creates the rows when missing and re-points them otherwise.
--   3. The quick-action seed then runs against guaranteed-present FKs.
--
-- Every step is idempotent against the partial unique index
-- (boardId, position) WHERE archivedAt IS NULL.

-- 1. Rename any legacy "Not answered" stage to "Never answered" — matches
-- the user's preferred wording. No-op if the row was already renamed
-- (or if it never existed).
UPDATE "PipelineStage"
   SET "name" = 'Never answered', "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'pstg_seed_not_answered'
   AND "name" = 'Not answered';

-- 2. Archive the legacy lifecycle stages on the default board so the
-- kanban starts clean. Forward-only — `pipeline.stage.restore` brings
-- them back at any time. No-op for stages already archived.
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
-- sentinel position (current + 1000). Frees positions 1-8 no matter
-- what is there — including rows from a previous failed attempt of
-- this migration, OR a custom stage someone created at position 6, OR
-- a "Call completed" row whose id is not pstg_seed_call_completed
-- (the original board-seed migration only created the seeded id
-- conditionally; some environments have a name-matched row instead).
-- The `< 1000` guard makes this step idempotent across re-runs.
UPDATE "PipelineStage"
   SET "position" = "position" + 1000, "updatedAt" = CURRENT_TIMESTAMP
 WHERE "boardId" = 'board_seed_default'
   AND "archivedAt" IS NULL
   AND "position" < 1000;

-- 4. UPSERT the complete target stage set. Six new columns at 1-6 +
-- pstg_seed_not_answered at 7 + pstg_seed_call_completed at 8. We
-- UPSERT all eight (not just the new six) so the BoardQuickAction
-- inserts below have guaranteed FK targets — some environments
-- lack the call_completed / not_answered seeded ids entirely
-- (see commentary above).
INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "boardId", "updatedAt")
VALUES
  ('pstg_seed_new_leads',         'New leads',          1, 'blue-500',    false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_scheduled_9_1',     'Scheduled 9am-1pm',  2, 'violet-500',  false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_scheduled_1_4',     'Scheduled 1pm-4pm',  3, 'fuchsia-500', false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_scheduled_4_8',     'Scheduled 4pm-8pm',  4, 'pink-500',    false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_called_once',       'Called once',        5, 'amber-500',   false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_called_twice',      'Called twice',       6, 'orange-500',  false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_not_answered',      'Never answered',     7, 'rose-500',    false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_call_completed',    'Call completed',     8, 'sky-500',     false, 'board_seed_default', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name"       = EXCLUDED."name",
      "position"   = EXCLUDED."position",
      "color"      = EXCLUDED."color",
      "isClosed"   = EXCLUDED."isClosed",
      "boardId"    = EXCLUDED."boardId",
      "archivedAt" = NULL,
      "updatedAt"  = CURRENT_TIMESTAMP;

-- 5. Seed the three quick-action buttons the user wanted. Each button
-- adds a templated comment and moves the card to the named stage.
-- Editable from board settings; archive any that are no longer useful.
-- All three targetStageIds are now guaranteed present (step 4 just
-- UPSERTed them).
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

-- 6. Clear the legacy tick/X pointers on the default board — the
-- multi-row BoardQuickAction catalogue takes over rendering.
UPDATE "Board"
   SET "tickActionStageId" = NULL,
       "xActionStageId"    = NULL,
       "updatedAt"         = CURRENT_TIMESTAMP
 WHERE "id" = 'board_seed_default';
