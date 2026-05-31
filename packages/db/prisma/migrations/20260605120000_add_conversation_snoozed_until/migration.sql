-- ADR 0020 Phase 6g — snooze a conversation until a time. Adds the timestamp
-- that the `trengo/unsnooze-due` cron reads to resurface snoozed
-- conversations into the active inbox. CLAUDE.md §11.
--
-- Forward-only (CLAUDE.md §19); additive nullable column. A partial index on
-- (status, snoozedUntil) keeps the cron's "due snoozes" scan cheap regardless
-- of inbox size.

ALTER TABLE "Conversation"
    ADD COLUMN "snoozedUntil" TIMESTAMP(3);

CREATE INDEX "Conversation_snooze_due_idx"
    ON "Conversation"("snoozedUntil")
    WHERE "status" = 'snoozed' AND "snoozedUntil" IS NOT NULL;
