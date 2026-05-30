-- Card sub-tasks: Todoist-style checklist items ON a card. Distinct from the
-- CRM Task table — lightweight, card-local checkboxes. Forward-only
-- (CLAUDE.md §19).

CREATE TABLE "CardSubtask" (
    "id"          TEXT NOT NULL,
    "cardId"      TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "completed"   BOOLEAN NOT NULL DEFAULT false,
    "position"    INTEGER NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    CONSTRAINT "CardSubtask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CardSubtask_cardId_position_idx" ON "CardSubtask"("cardId", "position");

ALTER TABLE "CardSubtask"
    ADD CONSTRAINT "CardSubtask_cardId_fkey"
    FOREIGN KEY ("cardId") REFERENCES "Card"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
