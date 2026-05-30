-- Card side-rail: optional assignee (User FK), due date, priority. Surfaced
-- on the board kanban + modal so cards behave like proper task tickets.
-- Forward-only (CLAUDE.md §19).

ALTER TABLE "Card"
    ADD COLUMN "assigneeId" TEXT,
    ADD COLUMN "dueAt"      TIMESTAMP(3),
    ADD COLUMN "priority"   INTEGER;

CREATE INDEX "Card_assigneeId_idx" ON "Card"("assigneeId");
CREATE INDEX "Card_dueAt_idx"      ON "Card"("dueAt");

ALTER TABLE "Card"
    ADD CONSTRAINT "Card_assigneeId_fkey"
    FOREIGN KEY ("assigneeId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
