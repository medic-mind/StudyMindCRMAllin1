-- ADR 0017 — comprehensive customer view + 90-day historic backfill.
--
-- Adds:
--   1. Three partial indexes on Interaction that make the per-channel
--      view-models cheap on contacts with thousands of timeline rows.
--   2. BackfillJob tracking model + supporting enums.
--
-- Forward-only per CLAUDE.md §19. The Interaction indexes are partial
-- (`WHERE "deletedAt" IS NULL`) — all production reads of these channels
-- filter soft-deleted rows already, so the partial form keeps the index
-- small without sacrificing planner coverage.

-- 1. Per-channel index for `WHERE contactId = ? AND type = ? ORDER BY occurredAt DESC`.
CREATE INDEX "Interaction_contactId_type_occurredAt_partial_idx"
  ON "Interaction" ("contactId", "type", "occurredAt" DESC)
  WHERE "deletedAt" IS NULL;

-- 2. Email-thread grouping. Gmail messages live as `email_received` /
--    `email_sent` Interactions with `payload.gmailThreadId` set by the
--    Gmail sync (packages/integrations/gmail/src/jobs.ts).
CREATE INDEX "Interaction_email_thread_idx"
  ON "Interaction" ((payload->>'gmailThreadId'))
  WHERE "deletedAt" IS NULL
    AND "type" IN ('email_received', 'email_sent')
    AND payload ? 'gmailThreadId';

-- 3. Trengo conversation grouping. Trengo writes the conversation id under
--    `payload.ticketId` (legacy: ticket_id is Trengo's term for a
--    conversation thread). CLAUDE.md §11.
CREATE INDEX "Interaction_trengo_ticket_idx"
  ON "Interaction" ((payload->>'ticketId'))
  WHERE "deletedAt" IS NULL
    AND "type" = 'message'
    AND payload ? 'ticketId';

-- 4. BackfillJob enums + table.

CREATE TYPE "BackfillProvider" AS ENUM ('gmail', 'aircall', 'trengo', 'slack');

CREATE TYPE "BackfillJobStatus" AS ENUM (
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
);

CREATE TABLE "BackfillJob" (
  "id"             TEXT NOT NULL,
  "provider"       "BackfillProvider" NOT NULL,
  "agentId"        TEXT,
  "windowFrom"     TIMESTAMP(3) NOT NULL,
  "windowTo"       TIMESTAMP(3) NOT NULL,
  "status"         "BackfillJobStatus" NOT NULL DEFAULT 'pending',
  "totalCount"     INTEGER,
  "processedCount" INTEGER NOT NULL DEFAULT 0,
  "matchedCount"   INTEGER NOT NULL DEFAULT 0,
  "skippedCount"   INTEGER NOT NULL DEFAULT 0,
  "lastEventId"    TEXT,
  "error"          TEXT,
  "startedAt"      TIMESTAMP(3),
  "completedAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "createdById"    TEXT,
  "updatedById"    TEXT,

  CONSTRAINT "BackfillJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BackfillJob_provider_agentId_status_idx"
  ON "BackfillJob" ("provider", "agentId", "status");

CREATE INDEX "BackfillJob_status_createdAt_idx"
  ON "BackfillJob" ("status", "createdAt");
