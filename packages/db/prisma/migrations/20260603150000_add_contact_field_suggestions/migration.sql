-- ADR 0020 Phase 6c — surface inbound contact-field edits for human
-- confirmation. CLAUDE.md §3: AI/automation suggests, humans confirm. We
-- never silent-merge a Trengo `contact.updated` (or Gmail signature parse,
-- or anything else) into the Contact row; we write the proposal here and
-- let staff accept or reject it.
--
-- Forward-only (CLAUDE.md §19). Additive — fresh table, no impact on
-- existing rows. The unique constraint on (source, sourceEventId, field)
-- makes the write idempotent against a replayed webhook.

CREATE TYPE "ContactFieldSuggestionStatus" AS ENUM (
    'pending',
    'accepted',
    'rejected',
    'superseded'
);

CREATE TABLE "ContactFieldSuggestion" (
    "id"              TEXT NOT NULL,
    "contactId"       TEXT NOT NULL,
    "source"          TEXT NOT NULL,
    "sourceEventId"   TEXT NOT NULL,
    "field"           TEXT NOT NULL,
    "proposedValue"   TEXT,
    "currentValue"    TEXT,
    "status"          "ContactFieldSuggestionStatus" NOT NULL DEFAULT 'pending',
    "reviewedAt"      TIMESTAMP(3),
    "reviewedById"    TEXT,
    "rejectionReason" TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactFieldSuggestion_pkey" PRIMARY KEY ("id")
);

-- Replay-safe: the same source event delivering the same field twice picks
-- up the existing row instead of inserting a duplicate.
CREATE UNIQUE INDEX "ContactFieldSuggestion_source_sourceEventId_field_key"
    ON "ContactFieldSuggestion"("source", "sourceEventId", "field");

-- Queue read path: list pending suggestions ordered by recency.
CREATE INDEX "ContactFieldSuggestion_status_createdAt_idx"
    ON "ContactFieldSuggestion"("status", "createdAt");

-- Per-contact lookup so the contact page can show outstanding proposals.
CREATE INDEX "ContactFieldSuggestion_contactId_status_idx"
    ON "ContactFieldSuggestion"("contactId", "status");

ALTER TABLE "ContactFieldSuggestion"
    ADD CONSTRAINT "ContactFieldSuggestion_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
