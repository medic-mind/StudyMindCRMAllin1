-- Store the human name of the Slack channel a complaint was actually posted to
-- (e.g. "#complaintcallsummaries") so the UI reports the REAL destination
-- instead of a hardcoded guess. Additive, forward-only (CLAUDE.md §19).
ALTER TABLE "Complaint" ADD COLUMN "slackChannelName" TEXT;
