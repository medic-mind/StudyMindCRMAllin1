-- Complaint: idempotency key for system-raised complaints (ADR 0042 — Slack
-- channel-aware ingestion). "slack:<channelId>:<ts>" for a complaint-channel
-- call summary; null for human-logged complaints. Unique so overlapping pull
-- windows / webhook+pull races converge on ONE complaint per Slack message.
-- Forward-only.
ALTER TABLE "Complaint" ADD COLUMN "sourceKey" TEXT;

CREATE UNIQUE INDEX "Complaint_sourceKey_key" ON "Complaint"("sourceKey");
