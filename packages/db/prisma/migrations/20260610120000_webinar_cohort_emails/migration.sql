-- Per-cohort email template + send schedule (CLAUDE.md §47). Email authoring
-- moves from global settings to the cohort so each cohort has its own weekly
-- reminder (with an optional HTML body) and send days/hour. Forward-only;
-- additive columns with safe defaults.

ALTER TABLE "WebinarCohort"
  ADD COLUMN "emailSubjectTemplate" TEXT,
  ADD COLUMN "emailBodyTemplate"    TEXT,
  ADD COLUMN "emailBodyHtml"        TEXT,
  ADD COLUMN "fromName"             TEXT,
  ADD COLUMN "sendDaysOfWeek"       INTEGER[] NOT NULL DEFAULT ARRAY[0, 1],
  ADD COLUMN "sendHourLocal"        INTEGER NOT NULL DEFAULT 9;
