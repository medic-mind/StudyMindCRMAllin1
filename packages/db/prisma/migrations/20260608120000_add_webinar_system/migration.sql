-- Weekly webinars / live-classes auto-enrollment system.
--
-- Parents pay weekly via Stripe for live subject classes; the CRM detects them,
-- organises them into the right class (deterministic matcher first, AI advisory
-- only when unsure — CLAUDE.md §3, §18), emails the Zoom link + a PDF schedule
-- each week, and stops when the subscription lapses. All new tables; no impact
-- on existing rows. Forward-only (CLAUDE.md §19).

-- Enums -----------------------------------------------------------------------
CREATE TYPE "WebinarLevel" AS ENUM ('gcse', 'a_level');
CREATE TYPE "WebinarCohortStatus" AS ENUM ('planning', 'active', 'archived');
CREATE TYPE "WebinarEnrollmentStatus" AS ENUM ('pending_review', 'active', 'paused', 'expired', 'cancelled');
CREATE TYPE "WebinarEnrollmentSource" AS ENUM ('auto_rule', 'ai_advisory', 'manual');
CREATE TYPE "WebinarDispatchStatus" AS ENUM ('scheduled', 'sent', 'skipped_holiday', 'skipped_inactive', 'failed');

-- WebinarCohort ---------------------------------------------------------------
CREATE TABLE "WebinarCohort" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "startsOn"    DATE NOT NULL,
    "endsOn"      DATE NOT NULL,
    "status"      "WebinarCohortStatus" NOT NULL DEFAULT 'planning',
    "timezone"    TEXT NOT NULL DEFAULT 'Europe/London',
    "notes"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt"   TIMESTAMP(3),

    CONSTRAINT "WebinarCohort_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebinarCohort_name_key" ON "WebinarCohort"("name");
CREATE INDEX "WebinarCohort_status_idx" ON "WebinarCohort"("status");

-- WebinarHoliday --------------------------------------------------------------
CREATE TABLE "WebinarHoliday" (
    "id"          TEXT NOT NULL,
    "cohortId"    TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "startsOn"    DATE NOT NULL,
    "endsOn"      DATE NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "WebinarHoliday_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WebinarHoliday_cohortId_idx" ON "WebinarHoliday"("cohortId");

-- WebinarClass ----------------------------------------------------------------
CREATE TABLE "WebinarClass" (
    "id"                     TEXT NOT NULL,
    "cohortId"               TEXT NOT NULL,
    "subject"                TEXT NOT NULL,
    "level"                  "WebinarLevel" NOT NULL,
    "title"                  TEXT NOT NULL,
    "dayOfWeek"              INTEGER NOT NULL,
    "startMinute"            INTEGER NOT NULL,
    "durationMins"           INTEGER NOT NULL DEFAULT 60,
    "timezone"               TEXT NOT NULL DEFAULT 'Europe/London',
    "zoomLink"               TEXT,
    "zoomLinkUpdatedAt"      TIMESTAMP(3),
    "zoomRotateEveryWeeks"   INTEGER NOT NULL DEFAULT 4,
    "sendOffsetHours"        INTEGER NOT NULL DEFAULT 24,
    "emailSubjectTemplate"   TEXT,
    "emailBodyTemplate"      TEXT,
    "active"                 BOOLEAN NOT NULL DEFAULT true,
    "syllabusPdfData"        BYTEA,
    "syllabusPdfFileName"    TEXT,
    "syllabusPdfContentType" TEXT,
    "syllabusPdfByteSize"    INTEGER,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,
    "createdById"            TEXT,
    "updatedById"            TEXT,
    "deletedAt"              TIMESTAMP(3),

    CONSTRAINT "WebinarClass_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebinarClass_cohortId_subject_level_key" ON "WebinarClass"("cohortId", "subject", "level");
CREATE INDEX "WebinarClass_cohortId_idx" ON "WebinarClass"("cohortId");
CREATE INDEX "WebinarClass_active_idx" ON "WebinarClass"("active");

-- WebinarSyllabusWeek ---------------------------------------------------------
CREATE TABLE "WebinarSyllabusWeek" (
    "id"          TEXT NOT NULL,
    "classId"     TEXT NOT NULL,
    "weekNumber"  INTEGER NOT NULL,
    "topic"       TEXT NOT NULL,
    "notes"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "WebinarSyllabusWeek_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebinarSyllabusWeek_classId_weekNumber_key" ON "WebinarSyllabusWeek"("classId", "weekNumber");
CREATE INDEX "WebinarSyllabusWeek_classId_idx" ON "WebinarSyllabusWeek"("classId");

-- WebinarEnrollment -----------------------------------------------------------
CREATE TABLE "WebinarEnrollment" (
    "id"                   TEXT NOT NULL,
    "classId"              TEXT NOT NULL,
    "contactId"            TEXT NOT NULL,
    "stripeSubscriptionId" TEXT,
    "stripeCustomerId"     TEXT,
    "status"               "WebinarEnrollmentStatus" NOT NULL DEFAULT 'pending_review',
    "source"               "WebinarEnrollmentSource" NOT NULL DEFAULT 'manual',
    "matchConfidence"      DOUBLE PRECISION,
    "matchReason"          TEXT,
    "expiresAt"            TIMESTAMP(3),
    "enrolledAt"           TIMESTAMP(3),
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,
    "createdById"          TEXT,
    "updatedById"          TEXT,
    "deletedAt"            TIMESTAMP(3),

    CONSTRAINT "WebinarEnrollment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebinarEnrollment_classId_contactId_key" ON "WebinarEnrollment"("classId", "contactId");
CREATE INDEX "WebinarEnrollment_contactId_idx" ON "WebinarEnrollment"("contactId");
CREATE INDEX "WebinarEnrollment_status_idx" ON "WebinarEnrollment"("status");
CREATE INDEX "WebinarEnrollment_stripeSubscriptionId_idx" ON "WebinarEnrollment"("stripeSubscriptionId");

-- WebinarEmailDispatch --------------------------------------------------------
CREATE TABLE "WebinarEmailDispatch" (
    "id"             TEXT NOT NULL,
    "classId"        TEXT NOT NULL,
    "enrollmentId"   TEXT NOT NULL,
    "weekNumber"     INTEGER NOT NULL,
    "sessionAt"      TIMESTAMP(3) NOT NULL,
    "status"         "WebinarDispatchStatus" NOT NULL DEFAULT 'scheduled',
    "gmailMessageId" TEXT,
    "error"          TEXT,
    "sentAt"         TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebinarEmailDispatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebinarEmailDispatch_enrollmentId_weekNumber_key" ON "WebinarEmailDispatch"("enrollmentId", "weekNumber");
CREATE INDEX "WebinarEmailDispatch_classId_weekNumber_idx" ON "WebinarEmailDispatch"("classId", "weekNumber");
CREATE INDEX "WebinarEmailDispatch_status_idx" ON "WebinarEmailDispatch"("status");

-- WebinarSettings -------------------------------------------------------------
CREATE TABLE "WebinarSettings" (
    "id"                          TEXT NOT NULL,
    "senderMailboxUserId"         TEXT,
    "defaultSendOffsetHours"      INTEGER NOT NULL DEFAULT 24,
    "defaultZoomRotateEveryWeeks" INTEGER NOT NULL DEFAULT 4,
    "emailSubjectTemplate"        TEXT NOT NULL,
    "emailBodyTemplate"           TEXT NOT NULL,
    "fromName"                    TEXT,
    "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                   TIMESTAMP(3) NOT NULL,
    "createdById"                 TEXT,
    "updatedById"                 TEXT,

    CONSTRAINT "WebinarSettings_pkey" PRIMARY KEY ("id")
);

-- Foreign keys ----------------------------------------------------------------
ALTER TABLE "WebinarHoliday" ADD CONSTRAINT "WebinarHoliday_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "WebinarCohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebinarClass" ADD CONSTRAINT "WebinarClass_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "WebinarCohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebinarSyllabusWeek" ADD CONSTRAINT "WebinarSyllabusWeek_classId_fkey" FOREIGN KEY ("classId") REFERENCES "WebinarClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebinarEnrollment" ADD CONSTRAINT "WebinarEnrollment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "WebinarClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebinarEnrollment" ADD CONSTRAINT "WebinarEnrollment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebinarEmailDispatch" ADD CONSTRAINT "WebinarEmailDispatch_classId_fkey" FOREIGN KEY ("classId") REFERENCES "WebinarClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebinarEmailDispatch" ADD CONSTRAINT "WebinarEmailDispatch_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "WebinarEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
