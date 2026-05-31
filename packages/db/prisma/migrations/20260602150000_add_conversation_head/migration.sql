-- ADR 0020 Phase 2 — first-class Conversation head for Trengo tickets.
--
-- Polymorphic `Interaction` stays the message-body source of truth; this row
-- carries the conversation's *current* state as indexed columns. Upserted by
-- the Trengo webhook job on every event and by the audited outbound when the
-- CRM initiates an action. Backfill from existing Interactions is a follow-up
-- per CLAUDE.md §19.1 — until then, contact-page derivation falls back to
-- the existing Interaction grouping for historic conversations.
--
-- Forward-only (CLAUDE.md §19). All new fields are nullable or have defaults
-- so existing rows are not affected (there are none — fresh table).

-- 1. Status enum.
CREATE TYPE "ConversationStatus" AS ENUM ('open', 'closed', 'snoozed', 'archived');

-- 2. Table.
CREATE TABLE "Conversation" (
    "id"               TEXT NOT NULL,
    "trengoTicketId"   INTEGER NOT NULL,
    "contactId"        TEXT,
    "familyId"         TEXT,
    "channel"          TEXT,
    "status"           "ConversationStatus" NOT NULL DEFAULT 'open',
    "assigneeUserId"   TEXT,
    "trengoAssigneeId" INTEGER,
    "lastMessageAt"    TIMESTAMP(3) NOT NULL,
    "lastInboundAt"    TIMESTAMP(3),
    "lastOutboundAt"   TIMESTAMP(3),
    "unreadCount"      INTEGER NOT NULL DEFAULT 0,
    "subject"          TEXT,
    "tags"             TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "replyDeadlineAt"  TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- 3. Unique constraint on Trengo's ticket id — one head per conversation.
CREATE UNIQUE INDEX "Conversation_trengoTicketId_key" ON "Conversation"("trengoTicketId");

-- 4. Read indexes. These cover the comms-centre filter set: status-ordered
--    by recency, by assignee, by channel-status, plus per-contact / per-family
--    lookups and an unread-count scan for the bell.
CREATE INDEX "Conversation_status_lastMessageAt_idx"
    ON "Conversation"("status", "lastMessageAt");
CREATE INDEX "Conversation_assigneeUserId_status_idx"
    ON "Conversation"("assigneeUserId", "status");
CREATE INDEX "Conversation_channel_status_idx"
    ON "Conversation"("channel", "status");
CREATE INDEX "Conversation_contactId_idx" ON "Conversation"("contactId");
CREATE INDEX "Conversation_familyId_idx" ON "Conversation"("familyId");
CREATE INDEX "Conversation_unreadCount_idx" ON "Conversation"("unreadCount");

-- 5. Foreign keys. SET NULL on Contact / Family delete so a soft-delete of the
--    contact does not orphan-fail a Conversation upsert when a future inbound
--    arrives. References match the application-level access pattern.
ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_familyId_fkey"
    FOREIGN KEY ("familyId") REFERENCES "Family"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
