-- Operator-managed Slack channels for the call-summary "Internal — Slack"
-- section (CLAUDE.md §10/§12). Replaces the single env-configured
-- SLACK_ALERTS_CHANNEL_ID with a pickable, editable list. Each option carries
-- optional deep-link action buttons (Block Kit) for virtual assistants.
--
-- Forward-only (CLAUDE.md §19). No seed: channel ids are deployment-specific,
-- and the call-summary sender falls back to SLACK_ALERTS_CHANNEL_ID when the
-- list is empty, so existing behaviour is preserved until an admin adds rows
-- from Settings → Slack channels.

CREATE TABLE "SlackChannelOption" (
    "id"            TEXT NOT NULL,
    "label"         TEXT NOT NULL,
    "channelId"     TEXT NOT NULL,
    "purpose"       TEXT,
    "isDefault"     BOOLEAN NOT NULL DEFAULT false,
    "actionButtons" JSONB NOT NULL DEFAULT '[]',
    "sortOrder"     INTEGER NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    "createdById"   TEXT,
    "updatedById"   TEXT,
    "archivedAt"    TIMESTAMP(3),
    CONSTRAINT "SlackChannelOption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SlackChannelOption_channelId_key" ON "SlackChannelOption"("channelId");
CREATE INDEX "SlackChannelOption_archivedAt_idx" ON "SlackChannelOption"("archivedAt");
CREATE INDEX "SlackChannelOption_sortOrder_idx" ON "SlackChannelOption"("sortOrder");
