-- Audit-B2 Chunk 5: OutboundEmailIntent. CLAUDE.md §14.
--
-- One row per outbound Gmail send. Idempotent on (threadId, requestId) so
-- a retried tRPC mutation cannot send a duplicate email. The Gmail message
-- id is filled in once Gmail accepts the send.

CREATE TABLE "OutboundEmailIntent" (
  "id"              TEXT PRIMARY KEY,
  "agentId"         TEXT NOT NULL,
  "threadId"        TEXT NOT NULL,
  "requestId"       TEXT NOT NULL,
  "gmailMessageId"  TEXT,
  "subject"         TEXT NOT NULL,
  "toAddresses"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "ccAddresses"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "bccAddresses"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"          TEXT NOT NULL DEFAULT 'pending',
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  "createdById"     TEXT,
  "updatedById"     TEXT
);

CREATE UNIQUE INDEX "OutboundEmailIntent_threadId_requestId_key"
  ON "OutboundEmailIntent" ("threadId", "requestId");

CREATE INDEX "OutboundEmailIntent_agentId_idx" ON "OutboundEmailIntent" ("agentId");
CREATE INDEX "OutboundEmailIntent_gmailMessageId_idx" ON "OutboundEmailIntent" ("gmailMessageId");
