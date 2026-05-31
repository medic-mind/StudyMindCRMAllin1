-- A scheduled call date+time on a board card (CLAUDE.md §6.4). Distinct from
-- `dueAt`: this is WHEN the agent will phone the contact, the core purpose of
-- the call-scheduling boards. Stored UTC; the UI picks/renders Europe/London.
-- Forward-only (CLAUDE.md §19) — existing cards take null.

ALTER TABLE "Card" ADD COLUMN "scheduledCallAt" TIMESTAMP(3);

CREATE INDEX "Card_scheduledCallAt_idx" ON "Card"("scheduledCallAt");
