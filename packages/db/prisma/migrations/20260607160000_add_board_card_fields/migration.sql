-- Operator-configurable "card face" — which preview fields show on every card
-- on a board (CLAUDE.md §6.4 boards). NULL = show all, so every existing board
-- keeps its current full card unchanged. Managers tune it from the board
-- settings page; no code change needed to declutter a board.
--
-- Forward-only (CLAUDE.md §19).

ALTER TABLE "Board" ADD COLUMN "cardFields" JSONB;
