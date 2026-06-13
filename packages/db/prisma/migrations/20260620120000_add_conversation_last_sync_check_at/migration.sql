-- Trengo status reconcile cursor (ADR 0020). The `trengo/reconcile-status`
-- cron re-fetches each conversation's CURRENT state from Trengo and
-- re-converges the head, so a dropped or unsubscribed lifecycle webhook
-- ("closed on Trengo, still open here") cannot leave the head drifted.
-- Ordered oldest-checked-first; null sorts first so unreconciled rows go now.
ALTER TABLE "Conversation" ADD COLUMN "lastSyncCheckAt" TIMESTAMP(3);

CREATE INDEX "Conversation_lastSyncCheckAt_idx" ON "Conversation"("lastSyncCheckAt");
