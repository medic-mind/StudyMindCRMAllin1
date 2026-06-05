-- Webinar mailing-list iteration: configurable reminder send-days (default
-- Mon+Tue) instead of a fixed pre-session offset, a per-enrolment billing
-- interval, and a per-reminder-day idempotency key on the dispatch log.
-- Forward-only (CLAUDE.md §19); new columns are additive with safe defaults.

-- WebinarClass: send-day model.
ALTER TABLE "WebinarClass"
  ADD COLUMN "sendDaysOfWeek" INTEGER[] NOT NULL DEFAULT ARRAY[0, 1],
  ADD COLUMN "sendHourLocal"  INTEGER NOT NULL DEFAULT 9;

-- WebinarSettings: matching defaults.
ALTER TABLE "WebinarSettings"
  ADD COLUMN "defaultSendDaysOfWeek" INTEGER[] NOT NULL DEFAULT ARRAY[0, 1],
  ADD COLUMN "defaultSendHourLocal"  INTEGER NOT NULL DEFAULT 9;

-- WebinarEnrollment: billing interval for display + reasoning.
ALTER TABLE "WebinarEnrollment"
  ADD COLUMN "billingInterval" TEXT;

-- WebinarEmailDispatch: per-reminder-day idempotency.
ALTER TABLE "WebinarEmailDispatch"
  ADD COLUMN "sendDayOfWeek" INTEGER NOT NULL DEFAULT 0;

DROP INDEX "WebinarEmailDispatch_enrollmentId_weekNumber_key";
CREATE UNIQUE INDEX "WebinarEmailDispatch_enrollmentId_weekNumber_sendDayOfWeek_key"
  ON "WebinarEmailDispatch"("enrollmentId", "weekNumber", "sendDayOfWeek");
