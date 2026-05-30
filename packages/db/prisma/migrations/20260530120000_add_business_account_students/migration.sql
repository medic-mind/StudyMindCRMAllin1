-- Students enrolled at a BusinessAccount (school / partnership). Each row is
-- one (account, student-name) pair — not a CRM Contact — so accounts can
-- track cohorts without pulling every pupil into the contact database.
-- Hours are split into `contracted` and `delivered`; the delivered figure
-- is the column the booking site sync will write to once wired (CLAUDE.md
-- §15). Forward-only (CLAUDE.md §19).

CREATE TYPE "BusinessAccountStudentStatus" AS ENUM (
    'active',
    'paused',
    'completed',
    'withdrawn'
);

CREATE TABLE "BusinessAccountStudent" (
    "id"                TEXT NOT NULL,
    "accountId"         TEXT NOT NULL,
    "firstName"         TEXT NOT NULL,
    "lastName"          TEXT,
    "yearGroup"         TEXT,
    "dateOfBirth"       TIMESTAMP(3),
    "program"           TEXT,
    "hoursContracted"   INTEGER,
    "hoursDelivered"    INTEGER,
    "startDate"         TIMESTAMP(3),
    "endDate"           TIMESTAMP(3),
    "status"            "BusinessAccountStudentStatus" NOT NULL DEFAULT 'active',
    "subjects"          TEXT,
    "notes"             TEXT,
    "bookingStudentId"  TEXT,
    "bookingLastSyncAt" TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    "createdById"       TEXT,
    "updatedById"       TEXT,
    "archivedAt"        TIMESTAMP(3),
    CONSTRAINT "BusinessAccountStudent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BusinessAccountStudent_accountId_idx"
    ON "BusinessAccountStudent"("accountId");
CREATE INDEX "BusinessAccountStudent_status_idx"
    ON "BusinessAccountStudent"("status");
CREATE INDEX "BusinessAccountStudent_archivedAt_idx"
    ON "BusinessAccountStudent"("archivedAt");
CREATE INDEX "BusinessAccountStudent_bookingStudentId_idx"
    ON "BusinessAccountStudent"("bookingStudentId");

ALTER TABLE "BusinessAccountStudent"
    ADD CONSTRAINT "BusinessAccountStudent_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "BusinessAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
