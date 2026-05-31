-- ADR 0021 Phase 3a — generalise Conversation beyond Trengo.
--
-- The conversation head was Trengo-only; this migration opens it up to other
-- providers (email first, Outlook/IMAP later) so the Comms Centre can render
-- one unified list. Strictly additive + one NULLABLE relaxation, no destructive
-- ops (CLAUDE.md §19 forward-only):
--   • `provider` (TEXT, nullable) — 'trengo' | 'email' | 'outlook' | 'imap'.
--     Existing rows stay NULL; downstream code treats NULL as 'trengo' since
--     that is the only kind that existed before this migration.
--   • `mailAccountId` (TEXT, nullable) — MailAccount.id for email-channel rows.
--     ON DELETE SET NULL so deleting a MailAccount never cascades to the head.
--   • `externalThreadId` (TEXT, nullable) — Gmail threadId, Outlook
--     conversationId, etc.
--   • `trengoTicketId` relaxed to NULLABLE so non-Trengo rows can exist; the
--     UNIQUE index from the previous migration stays in place (NULLs are not
--     uniqueness-compared in Postgres so multiple non-Trengo rows coexist).
--   • Composite UNIQUE on (provider, externalThreadId) prevents duplicate
--     email-thread heads. Trengo rows leave both columns NULL → not constrained.
--   • Two read indexes for the upcoming inbox queries.
--
-- A follow-up PR (Phase 3b) will populate `provider = 'trengo'` on the existing
-- rows via an Inngest backfill so we can flip the column to NOT NULL.

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "externalThreadId" TEXT,
ADD COLUMN     "mailAccountId" TEXT,
ADD COLUMN     "provider" TEXT,
ALTER COLUMN "trengoTicketId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Conversation_mailAccountId_status_idx" ON "Conversation"("mailAccountId", "status");

-- CreateIndex
CREATE INDEX "Conversation_provider_channel_idx" ON "Conversation"("provider", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_provider_externalThreadId_key" ON "Conversation"("provider", "externalThreadId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_mailAccountId_fkey" FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
