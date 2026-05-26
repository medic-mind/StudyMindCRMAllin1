-- Card detail modal (slice A) + universal task threads (slice B).
--
-- Adds the inline-editable `Card.description` column and the new
-- InteractionType enum values used by the card/task comment threads and the
-- card description-change timeline entry. Forward-only per CLAUDE.md §19;
-- Postgres enum additions are append-only.

-- New InteractionType enum values (append-only).
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'card_comment';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'card_description_changed';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'task_comment';

-- Card description column. Nullable; no backfill required.
ALTER TABLE "Card" ADD COLUMN "description" TEXT;
