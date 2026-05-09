-- Slice 7: Slack + Asana + Gmail.
-- See CLAUDE.md §12 (Slack), §13 (Asana), §14 (Gmail), §19 (enum additions
-- are append-only — Postgres requires bare ALTER TYPE for safety).

-- InteractionType: append-only additions. `slack_summary` already exists.
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'email_received';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'email_sent';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'task_created';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'task_updated';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'task_completed';

-- UnassignedSummary: low-confidence Slack summary parses land here for an
-- agent to triage. CLAUDE.md §12 — never auto-attach below the 0.7 threshold.
CREATE TABLE "UnassignedSummary" (
    "id" TEXT NOT NULL,
    "slackTs" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "parsed" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "UnassignedSummary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UnassignedSummary_slackTs_channelId_key"
    ON "UnassignedSummary"("slackTs", "channelId");
CREATE INDEX "UnassignedSummary_resolvedAt_idx" ON "UnassignedSummary"("resolvedAt");

-- SlackPost: idempotency record for outbound bot posts to #crm-alerts.
-- Replays return the existing slackTs rather than double-posting.
CREATE TABLE "SlackPost" (
    "idempotencyKey" TEXT NOT NULL,
    "slackTs" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackPost_pkey" PRIMARY KEY ("idempotencyKey")
);

CREATE INDEX "SlackPost_postedAt_idx" ON "SlackPost"("postedAt");

-- AsanaWebhook: stores the per-webhook secret Asana sends on creation.
-- The secret is echoed back in the X-Hook-Secret response header to complete
-- the handshake (CLAUDE.md §13). After that, every payload is HMAC-signed
-- with this secret.
CREATE TABLE "AsanaWebhook" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "webhookSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "AsanaWebhook_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AsanaWebhook_projectId_idx" ON "AsanaWebhook"("projectId");

-- GmailMailbox: per-agent Pub/Sub watch lifecycle.
-- We renew via the gmail/refresh-watch recurring job before the 7-day
-- expiry; storing watchExpiresAt lets the job filter cheaply (CLAUDE.md §14).
CREATE TABLE "GmailMailbox" (
    "agentId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "historyId" TEXT,
    "watchExpiresAt" TIMESTAMP(3),
    "topicName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "GmailMailbox_pkey" PRIMARY KEY ("agentId")
);

CREATE UNIQUE INDEX "GmailMailbox_address_key" ON "GmailMailbox"("address");
CREATE INDEX "GmailMailbox_watchExpiresAt_idx" ON "GmailMailbox"("watchExpiresAt");

-- Asana ↔ CRM linkage: every Asana task we sync stores its asanaTaskId on
-- the local Task row. The Task model already exists; add the columns here.
ALTER TABLE "Task" ADD COLUMN "asanaTaskId" TEXT;
ALTER TABLE "Task" ADD COLUMN "contactId" TEXT;
ALTER TABLE "Task" ADD COLUMN "lastWrittenBy" TEXT;
ALTER TABLE "Task" ADD COLUMN "lastWrittenAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Task_asanaTaskId_key" ON "Task"("asanaTaskId") WHERE "asanaTaskId" IS NOT NULL;
CREATE INDEX "Task_contactId_idx" ON "Task"("contactId");

-- Per-agent Gmail OAuth refresh token, KMS-encrypted at rest. CLAUDE.md §14.
CREATE TABLE "GmailToken" (
    "agentId" TEXT NOT NULL,
    "tokenCiphertext" BYTEA NOT NULL,
    "tokenIv" BYTEA NOT NULL,
    "dekCiphertext" BYTEA NOT NULL,
    "aad" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "GmailToken_pkey" PRIMARY KEY ("agentId")
);
