-- Contact lifecycle + engagement metrics from booking.studymind.co.uk
-- (CLAUDE.md §15). The booking-site puller is the only writer of these
-- columns: it moves a contact off the `lead` default once an account /
-- session is observed, and writes the per-contact hours / last-lesson /
-- spend figures. Kept directly on Contact (not rolled up through Family)
-- so the Contacts list reads them in one query. Forward-only (CLAUDE.md
-- §19) — existing rows take the `lead` default and null metrics.

CREATE TYPE "ContactBookingStatus" AS ENUM (
    'lead',
    'registered_no_hours',
    'registered_with_hours'
);

ALTER TABLE "Contact"
    ADD COLUMN "bookingStatus" "ContactBookingStatus" NOT NULL DEFAULT 'lead',
    ADD COLUMN "bookingContactId" TEXT,
    ADD COLUMN "bookingLastSyncAt" TIMESTAMP(3),
    ADD COLUMN "hoursBooked" INTEGER,
    ADD COLUMN "hoursDelivered" INTEGER,
    ADD COLUMN "lastLessonAt" TIMESTAMP(3),
    ADD COLUMN "amountSpentMinor" INTEGER;

CREATE INDEX "Contact_bookingStatus_idx" ON "Contact"("bookingStatus");
CREATE INDEX "Contact_bookingContactId_idx" ON "Contact"("bookingContactId");
