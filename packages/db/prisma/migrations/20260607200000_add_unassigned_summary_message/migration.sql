-- Archive the original Slack message + author on the unassigned-summaries tray
-- rows, so the triage UI shows what was actually said and the record survives
-- Slack's 90-day retention even before it is assigned to a contact (ADR 0034).
-- Forward-only (CLAUDE.md §19).

ALTER TABLE "UnassignedSummary" ADD COLUMN "messageText" TEXT;
ALTER TABLE "UnassignedSummary" ADD COLUMN "senderName" TEXT;
