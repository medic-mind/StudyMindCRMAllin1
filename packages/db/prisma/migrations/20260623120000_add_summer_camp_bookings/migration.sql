-- Summer Camp booking with instalment / deposit tracking.
-- Imported from the camp booking CSV (idempotent on dedupeKey); money in pence.
-- Remaining balance is derived (totalDue − depositPaid), never stored.

CREATE TABLE "SummerCampBooking" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'csv_import',
    "externalRef" TEXT,
    "bookingType" TEXT,
    "paymentType" TEXT,
    "subject" TEXT,
    "studentName" TEXT,
    "studentEmail" TEXT,
    "studentPhone" TEXT,
    "guardianName" TEXT,
    "guardianEmail" TEXT,
    "guardianPhone" TEXT,
    "totalDueMinor" INTEGER NOT NULL DEFAULT 0,
    "depositPaidMinor" INTEGER NOT NULL DEFAULT 0,
    "accomFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "researchProgramMinor" INTEGER NOT NULL DEFAULT 0,
    "weeks" TEXT,
    "noOfDays" INTEGER,
    "status" TEXT,
    "agent" TEXT,
    "dateOfPayment" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SummerCampBooking_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SummerCampBooking_dedupeKey_key" ON "SummerCampBooking"("dedupeKey");
CREATE INDEX "SummerCampBooking_paymentType_idx" ON "SummerCampBooking"("paymentType");
CREATE INDEX "SummerCampBooking_status_idx" ON "SummerCampBooking"("status");
CREATE INDEX "SummerCampBooking_deletedAt_idx" ON "SummerCampBooking"("deletedAt");
