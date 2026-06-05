-- Notification routing for Slack (Settings → Slack channels → "Where
-- notifications go"). Maps a code-defined notification topic to a Slack channel
-- so changing where a kind of message goes needs no code change.
--
-- Forward-only (CLAUDE.md §19). No seed: with no rows, senders fall back to
-- their existing default channel → env, so behaviour is unchanged until an
-- admin sets a route.

CREATE TABLE "SlackRoute" (
    "id"              TEXT NOT NULL,
    "topic"           TEXT NOT NULL,
    "channelOptionId" TEXT,
    "enabled"         BOOLEAN NOT NULL DEFAULT true,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "createdById"     TEXT,
    "updatedById"     TEXT,
    CONSTRAINT "SlackRoute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SlackRoute_topic_key" ON "SlackRoute"("topic");
CREATE INDEX "SlackRoute_channelOptionId_idx" ON "SlackRoute"("channelOptionId");

ALTER TABLE "SlackRoute"
  ADD CONSTRAINT "SlackRoute_channelOptionId_fkey"
  FOREIGN KEY ("channelOptionId") REFERENCES "SlackChannelOption"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
