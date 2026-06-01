-- Booking site mirror (booking.studymind.co.uk) — student-centric (ADR 0029).
--
-- The CRM mirrors the booking site read-only via an incremental pull
-- (docs/api/booking-pull-api.md). A booking "student" maps to a Contact
-- (kind = student) keyed on Contact.bookingContactId; the satellite tables
-- below hang off that Contact so the hot Contact row stays lean. These tables
-- coexist with the legacy family-centric Booking/BookingSession (CLAUDE.md §15,
-- §19 forward-only). Nothing here writes back to the booking site.

CREATE TYPE "BookingCreditKind" AS ENUM (
    'online_mmi',
    'in_person_mmi',
    'live_day',
    'in_person_live_day'
);

-- 1:1 satellite of Contact: the booking-site student snapshot.
CREATE TABLE "ContactBookingProfile" (
    "contactId"              TEXT NOT NULL,
    "legacyStudentId"        INTEGER,
    "hasGuardian"            BOOLEAN,
    "guardianName"           TEXT,
    "guardianPhoneE164"      TEXT,
    "guardianEmail"          TEXT,
    "receiveMarketingEmails" BOOLEAN,
    "addedByAgent"           BOOLEAN,
    "registeredAt"           TIMESTAMP(3),
    "hoursAdded"             DECIMAL(8,2),
    "hoursUsed"              DECIMAL(8,2),
    "hoursDeducted"          DECIMAL(8,2),
    "hoursRemaining"         DECIMAL(8,2),
    "premiumHoursAdded"      DECIMAL(8,2),
    "premiumHoursUsed"       DECIMAL(8,2),
    "premiumHoursDeducted"   DECIMAL(8,2),
    "premiumHoursRemaining"  DECIMAL(8,2),
    "nextHoursExpiryAt"      TIMESTAMP(3),
    "creditsOnlineMmi"       INTEGER NOT NULL DEFAULT 0,
    "creditsInPersonMmi"     INTEGER NOT NULL DEFAULT 0,
    "creditsLiveDay"         INTEGER NOT NULL DEFAULT 0,
    "creditsInPersonLiveDay" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt"           TIMESTAMP(3),
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContactBookingProfile_pkey" PRIMARY KEY ("contactId")
);

CREATE INDEX "ContactBookingProfile_legacyStudentId_idx"
    ON "ContactBookingProfile"("legacyStudentId");

ALTER TABLE "ContactBookingProfile"
    ADD CONSTRAINT "ContactBookingProfile_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- One lesson from /admin/lessons/, keyed on the booking lesson id.
CREATE TABLE "BookingLesson" (
    "id"                  TEXT NOT NULL,
    "externalId"          TEXT NOT NULL,
    "contactId"           TEXT NOT NULL,
    "tutorExternalId"     TEXT,
    "tutorName"           TEXT,
    "subject"             TEXT,
    "startsAt"            TIMESTAMP(3) NOT NULL,
    "endsAt"              TIMESTAMP(3),
    "durationMinutes"     INTEGER NOT NULL DEFAULT 0,
    "status"              TEXT NOT NULL,
    "payment"             TEXT,
    "isTrial"             BOOLEAN NOT NULL DEFAULT false,
    "trialFeedback"       TEXT,
    "trialFeedbackStatus" TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    "deletedAt"           TIMESTAMP(3),
    CONSTRAINT "BookingLesson_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingLesson_externalId_key" ON "BookingLesson"("externalId");
CREATE INDEX "BookingLesson_contactId_startsAt_idx" ON "BookingLesson"("contactId", "startsAt");
CREATE INDEX "BookingLesson_status_idx" ON "BookingLesson"("status");

ALTER TABLE "BookingLesson"
    ADD CONSTRAINT "BookingLesson_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- One row of the Balance History (the hours ledger). Hours are signed.
CREATE TABLE "BookingHoursTransaction" (
    "id"              TEXT NOT NULL,
    "externalId"      TEXT NOT NULL,
    "contactId"       TEXT NOT NULL,
    "hours"           DECIMAL(8,2) NOT NULL,
    "isPremium"       BOOLEAN NOT NULL DEFAULT false,
    "amountMinor"     INTEGER,
    "stripeReference" TEXT,
    "message"         TEXT,
    "type"            TEXT NOT NULL,
    "adminExternalId" TEXT,
    "adminName"       TEXT,
    "occurredAt"      TIMESTAMP(3) NOT NULL,
    "expiresAt"       TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "deletedAt"       TIMESTAMP(3),
    CONSTRAINT "BookingHoursTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingHoursTransaction_externalId_key"
    ON "BookingHoursTransaction"("externalId");
CREATE INDEX "BookingHoursTransaction_contactId_occurredAt_idx"
    ON "BookingHoursTransaction"("contactId", "occurredAt");
CREATE INDEX "BookingHoursTransaction_expiresAt_idx"
    ON "BookingHoursTransaction"("expiresAt");

ALTER TABLE "BookingHoursTransaction"
    ADD CONSTRAINT "BookingHoursTransaction_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- One row of the Credit History (MMI / Live Day credits).
CREATE TABLE "BookingCreditTransaction" (
    "id"              TEXT NOT NULL,
    "externalId"      TEXT NOT NULL,
    "contactId"       TEXT NOT NULL,
    "creditKind"      "BookingCreditKind" NOT NULL,
    "credits"         INTEGER NOT NULL,
    "amountMinor"     INTEGER,
    "stripeReference" TEXT,
    "message"         TEXT,
    "type"            TEXT NOT NULL,
    "adminExternalId" TEXT,
    "adminName"       TEXT,
    "occurredAt"      TIMESTAMP(3) NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "deletedAt"       TIMESTAMP(3),
    CONSTRAINT "BookingCreditTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingCreditTransaction_externalId_key"
    ON "BookingCreditTransaction"("externalId");
CREATE INDEX "BookingCreditTransaction_contactId_occurredAt_idx"
    ON "BookingCreditTransaction"("contactId", "occurredAt");
CREATE INDEX "BookingCreditTransaction_creditKind_idx"
    ON "BookingCreditTransaction"("creditKind");

ALTER TABLE "BookingCreditTransaction"
    ADD CONSTRAINT "BookingCreditTransaction_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-resource incremental-sync cursor for the booking pull.
CREATE TABLE "BookingSyncCursor" (
    "resource"     TEXT NOT NULL,
    "updatedSince" TIMESTAMP(3),
    "cursor"       TEXT,
    "lastRunAt"    TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BookingSyncCursor_pkey" PRIMARY KEY ("resource")
);
