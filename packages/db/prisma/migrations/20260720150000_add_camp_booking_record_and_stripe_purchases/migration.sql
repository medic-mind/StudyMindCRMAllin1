-- Summer Camp central record (CLAUDE.md §37 summer-camp row).
--
-- 1. "CampBookingRecord" — the CRM's own durable copy of every camp booking
--    (webhook + backfill + 15-min reconcile + CRM-originated creates all
--    upsert it, keyed on the camp app's booking uuid). The bookings workspace
--    reads THIS table, so the record survives camp-app downtime and each row
--    links to the customer Contacts.
-- 2. "CampStripePurchase" — Stripe charges whose product text matched
--    "summer camp" / "work experience" (detected on the charge.succeeded
--    pipeline), auto-turned into camp bookings through the CRM; failures stay
--    pending in a review tray. Idempotent on the Stripe charge id.
--
-- Forward-only, idempotent (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS "CampBookingRecord" (
    "id" TEXT NOT NULL,
    "externalBookingId" TEXT NOT NULL,
    "status" TEXT,
    "bookingType" TEXT,
    "subject" TEXT,
    "programmeType" TEXT,
    "campId" TEXT,
    "campName" TEXT,
    "campYear" INTEGER,
    "enrolledCampIds" JSONB NOT NULL DEFAULT '[]',
    "weekNumber" INTEGER,
    "weekLabel" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "daysBooked" INTEGER,
    "multipleWeeks" BOOLEAN NOT NULL DEFAULT false,
    "bookedWeeks" JSONB NOT NULL DEFAULT '[]',
    "withAccommodation" BOOLEAN NOT NULL DEFAULT false,
    "withTransfer" BOOLEAN NOT NULL DEFAULT false,
    "totalMinor" INTEGER,
    "paidMinor" INTEGER,
    "paymentType" TEXT,
    "paymentReference" TEXT,
    "agentName" TEXT,
    "campNotes" TEXT,
    "notesLog" JSONB NOT NULL DEFAULT '[]',
    "campStudentId" TEXT,
    "studentName" TEXT,
    "studentEmail" TEXT,
    "guardianName" TEXT,
    "guardianEmail" TEXT,
    "guardianPhone" TEXT,
    "dietaryRequirements" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "studentContactId" TEXT,
    "guardianContactId" TEXT,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CampBookingRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CampBookingRecord_externalBookingId_key" ON "CampBookingRecord"("externalBookingId");
CREATE INDEX IF NOT EXISTS "CampBookingRecord_status_idx" ON "CampBookingRecord"("status");
CREATE INDEX IF NOT EXISTS "CampBookingRecord_campId_idx" ON "CampBookingRecord"("campId");
CREATE INDEX IF NOT EXISTS "CampBookingRecord_campYear_idx" ON "CampBookingRecord"("campYear");
CREATE INDEX IF NOT EXISTS "CampBookingRecord_weekNumber_idx" ON "CampBookingRecord"("weekNumber");
CREATE INDEX IF NOT EXISTS "CampBookingRecord_studentContactId_idx" ON "CampBookingRecord"("studentContactId");
CREATE INDEX IF NOT EXISTS "CampBookingRecord_guardianContactId_idx" ON "CampBookingRecord"("guardianContactId");
CREATE INDEX IF NOT EXISTS "CampBookingRecord_sourceCreatedAt_idx" ON "CampBookingRecord"("sourceCreatedAt" DESC);

DO $$ BEGIN
  ALTER TABLE "CampBookingRecord"
    ADD CONSTRAINT "CampBookingRecord_studentContactId_fkey"
    FOREIGN KEY ("studentContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CampBookingRecord"
    ADD CONSTRAINT "CampBookingRecord_guardianContactId_fkey"
    FOREIGN KEY ("guardianContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "CampStripePurchase" (
    "id" TEXT NOT NULL,
    "stripeChargeId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'gbp',
    "customerName" TEXT,
    "customerEmail" TEXT,
    "productText" TEXT,
    "matchedKeyword" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "externalBookingId" TEXT,
    "contactId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "CampStripePurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CampStripePurchase_stripeChargeId_key" ON "CampStripePurchase"("stripeChargeId");
CREATE INDEX IF NOT EXISTS "CampStripePurchase_status_idx" ON "CampStripePurchase"("status");
CREATE INDEX IF NOT EXISTS "CampStripePurchase_createdAt_idx" ON "CampStripePurchase"("createdAt" DESC);

DO $$ BEGIN
  ALTER TABLE "CampStripePurchase"
    ADD CONSTRAINT "CampStripePurchase_externalBookingId_fkey"
    FOREIGN KEY ("externalBookingId") REFERENCES "CampBookingRecord"("externalBookingId") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CampStripePurchase"
    ADD CONSTRAINT "CampStripePurchase_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
