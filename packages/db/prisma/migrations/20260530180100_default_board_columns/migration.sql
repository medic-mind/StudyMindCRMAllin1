-- Default sales board columns + seed quick actions. The operator-managed
-- pipeline can be edited freely from /pipeline/manage afterwards — these
-- seeds give the board the user's preferred starting layout.
--
-- Forward-only (CLAUDE.md §19). Legacy lifecycle stages are archived
-- (soft-flag) rather than deleted, so Family.stageId references stay
-- valid and stages can be restored if needed.
--
-- Order matters: we have a partial unique index on
-- (boardId, position) WHERE archivedAt IS NULL, so we have to clear
-- positions 1-6 before inserting new stages there. Legacy lifecycle
-- stages (positions 1-5) get archived; the existing Call completed +
-- Not answered (positions 6 + 7) get parked at sentinel positions
-- BEFORE the new inserts, then re-positioned at 7 + 8 afterwards.

-- 1. Rename the legacy "Not answered" stage to "Never answered" — matches
-- the user's preferred wording. Does nothing if the row was already
-- renamed.
UPDATE "PipelineStage"
   SET "name" = 'Never answered', "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'pstg_seed_not_answered'
   AND "name" = 'Not answered';

-- 2. Archive the legacy lifecycle stages on the default board so the
-- kanban starts clean. Forward-only — `pipeline.stage.restore` brings them
-- back at any time.
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

-- 3. Park the existing Call completed + Never answered stages at sentinel
-- positions BEFORE we insert the new columns. Both currently sit at
-- positions in the 6-8 range (from the original board seed); we move them
-- to 1000+ so positions 1-6 are free for the new stages.
UPDATE "PipelineStage"
   SET "position" = 1001, "boardId" = 'board_seed_default',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'pstg_seed_call_completed';

UPDATE "PipelineStage"
   SET "position" = 1002, "boardId" = 'board_seed_default',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "id" = 'pstg_seed_not_answered';

-- 4. Insert the user's preferred columns. Idempotent on the stable seed
-- ids so re-running the migration is safe.
INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "boardId", "updatedAt")
VALUES
  ('pstg_seed_new_leads',         'New leads',          1, 'blue-500',    false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_scheduled_9_1',     'Scheduled 9am-1pm',  2, 'violet-500',  false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_scheduled_1_4',     'Scheduled 1pm-4pm',  3, 'fuchsia-500', false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_scheduled_4_8',     'Scheduled 4pm-8pm',  4, 'pink-500',    false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_called_once',       'Called once',        5, 'amber-500',   false, 'board_seed_default', CURRENT_TIMESTAMP),
  ('pstg_seed_called_twice',      'Called twice',       6, 'orange-500',  false, 'board_seed_default', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- 5. Re-position the existing Never answered + Call completed at the
-- end of the board, after the new columns.
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
