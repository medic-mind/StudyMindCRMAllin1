-- Slack reliability (audit 2026-07): persist the channel name on parked
-- mentions so the relink drain's call-log-channel decision (name-only
-- onboarding) is deterministic without a live conversations.info call, and add
-- a keyset index for the paged drain. Forward-only.

ALTER TABLE "UnassignedSummary" ADD COLUMN "channelName" TEXT;

CREATE INDEX "UnassignedSummary_resolvedAt_id_idx"
  ON "UnassignedSummary"("resolvedAt", "id");
