-- Customisable peak-times windows for the Aircall analytics (CLAUDE.md §10).
-- Each row marks a recurring season (month/day range, wrapping the year-end
-- when start > end), a set of weekdays (0=Mon..6=Sun), and an hour band
-- [startHour, endHour) as "peak". `year` null = every year; set = pinned to one
-- calendar year. Managed by Manager+ on the Aircall report; read by
-- reports.aircall.summary to classify calls (Europe/London clock).
--
-- Forward-only (CLAUDE.md §19); new table, no impact on existing rows.

CREATE TABLE "CallPeakWindow" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "startMonth"  INTEGER NOT NULL,
    "startDay"    INTEGER NOT NULL,
    "endMonth"    INTEGER NOT NULL,
    "endDay"      INTEGER NOT NULL,
    "daysOfWeek"  INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "startHour"   INTEGER NOT NULL,
    "endHour"     INTEGER NOT NULL,
    "year"        INTEGER,
    "color"       TEXT NOT NULL DEFAULT 'amber-500',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "archivedAt"  TIMESTAMP(3),

    CONSTRAINT "CallPeakWindow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CallPeakWindow_archivedAt_idx" ON "CallPeakWindow"("archivedAt");
CREATE INDEX "CallPeakWindow_year_idx" ON "CallPeakWindow"("year");
