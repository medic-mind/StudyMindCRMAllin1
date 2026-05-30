-- Configurable per-board quick-action buttons. Replaces the legacy
-- single-tick / single-X pair on Board (those columns are retained per
-- CLAUDE.md §19 forward-only). Each row is one button on every card on
-- the board, with its own label, colour, target stage, and optional
-- comment template. `targetBoardId` makes the move cross-pipeline.
--
-- Forward-only.

CREATE TABLE "BoardQuickAction" (
    "id"              TEXT NOT NULL,
    "boardId"         TEXT NOT NULL,
    "label"           TEXT NOT NULL,
    "color"           TEXT,
    "targetStageId"   TEXT NOT NULL,
    "targetBoardId"   TEXT,
    "commentTemplate" TEXT,
    "sortOrder"       INTEGER NOT NULL DEFAULT 0,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "createdById"     TEXT,
    "updatedById"     TEXT,
    "archivedAt"      TIMESTAMP(3),
    CONSTRAINT "BoardQuickAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BoardQuickAction_boardId_idx" ON "BoardQuickAction"("boardId");
CREATE INDEX "BoardQuickAction_archivedAt_idx" ON "BoardQuickAction"("archivedAt");
CREATE INDEX "BoardQuickAction_sortOrder_idx" ON "BoardQuickAction"("sortOrder");

ALTER TABLE "BoardQuickAction"
    ADD CONSTRAINT "BoardQuickAction_boardId_fkey"
    FOREIGN KEY ("boardId") REFERENCES "Board"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BoardQuickAction"
    ADD CONSTRAINT "BoardQuickAction_targetStageId_fkey"
    FOREIGN KEY ("targetStageId") REFERENCES "PipelineStage"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
