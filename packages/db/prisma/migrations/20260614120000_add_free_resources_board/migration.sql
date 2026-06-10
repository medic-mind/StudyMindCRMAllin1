-- Free Resources board (ADR 0023). Enquiries from "free resource / download /
-- guide" forms route to their own kanban instead of cluttering the Sales
-- Pipeline. The lead classifier flags these (a `Free Resources` URL-rule
-- category, or a freebie/download slug) and the job drops the card here.
-- Idempotent: guards on the seed ids so re-running is a no-op.

-- 1. The board.
INSERT INTO "Board" ("id", "name", "description", "position", "isDefault", "updatedAt")
SELECT
  'board_seed_free_resources',
  'Free Resources',
  'Enquiries from free-resource / download / guide forms. Separate from the Sales Pipeline — these are top-of-funnel freebie requests, not booked sales leads.',
  COALESCE((SELECT MAX("position") FROM "Board" WHERE "archivedAt" IS NULL), 0) + 1,
  false,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "Board" WHERE "id" = 'board_seed_free_resources'
);

-- 2. Stages. "New leads" is named to match the job's stage resolver (it looks
--    for a "New leads" stage by name first, on every board).
INSERT INTO "PipelineStage" ("id", "name", "position", "color", "isClosed", "boardId", "updatedAt")
VALUES
  ('pstg_seed_fr_new',       'New leads',      1, 'emerald-500', false, 'board_seed_free_resources', CURRENT_TIMESTAMP),
  ('pstg_seed_fr_sent',      'Resource sent',  2, 'sky-500',     false, 'board_seed_free_resources', CURRENT_TIMESTAMP),
  ('pstg_seed_fr_nurture',   'Nurturing',      3, 'violet-500',  false, 'board_seed_free_resources', CURRENT_TIMESTAMP),
  ('pstg_seed_fr_converted', 'Became a lead',  4, 'amber-500',   false, 'board_seed_free_resources', CURRENT_TIMESTAMP),
  ('pstg_seed_fr_closed',    'Closed',         5, 'neutral-500', true,  'board_seed_free_resources', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE
  SET "name"       = EXCLUDED."name",
      "color"      = EXCLUDED."color",
      "isClosed"   = EXCLUDED."isClosed",
      "boardId"    = EXCLUDED."boardId",
      "archivedAt" = NULL,
      "updatedAt"  = CURRENT_TIMESTAMP;

-- 3. A quick-action chip on the Free Resources board to move a warmed-up
--    freebie request onto the Sales Pipeline's New leads (cross-board).
INSERT INTO "BoardQuickAction" ("id", "boardId", "label", "color",
    "targetStageId", "targetBoardId", "commentTemplate", "sortOrder", "updatedAt")
SELECT
  'bqa_seed_fr_to_sales',
  'board_seed_free_resources',
  'Move to Sales',
  '#10b981',
  'pstg_seed_new_leads',
  'board_seed_default',
  'Warmed up from a free resource — moving to the Sales Pipeline.',
  10,
  CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "PipelineStage" WHERE "id" = 'pstg_seed_new_leads')
  AND NOT EXISTS (SELECT 1 FROM "BoardQuickAction" WHERE "id" = 'bqa_seed_fr_to_sales');

-- 4. Seed URL-classification rules so the classifier recognises free-resource
--    forms by slug / form title. Editable from the CRM; ops can add more
--    (any rule whose category is "Free Resources" routes to this board).
INSERT INTO "UrlClassificationRule"
  ("id", "label", "pattern", "matchType", "productTags", "categories", "brandId", "priority", "active", "updatedAt")
VALUES
  ('urc_seed_free_resources', 'Free resources', 'free-resources', 'contains', ARRAY[]::TEXT[], ARRAY['Free Resources'], NULL, 40, true, CURRENT_TIMESTAMP),
  ('urc_seed_free_download',  'Free download',  'free-download',  'contains', ARRAY[]::TEXT[], ARRAY['Free Resources'], NULL, 40, true, CURRENT_TIMESTAMP),
  ('urc_seed_free_guide',     'Free guide',     'free-guide',     'contains', ARRAY[]::TEXT[], ARRAY['Free Resources'], NULL, 40, true, CURRENT_TIMESTAMP),
  ('urc_seed_download',       'Download',       'download',       'contains', ARRAY[]::TEXT[], ARRAY['Free Resources'], NULL, 45, true, CURRENT_TIMESTAMP),
  ('urc_seed_cheat_sheet',    'Cheat sheet',    'cheat-sheet',    'contains', ARRAY[]::TEXT[], ARRAY['Free Resources'], NULL, 45, true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
