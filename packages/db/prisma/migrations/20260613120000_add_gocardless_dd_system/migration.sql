-- ADR 0038: GoCardless Direct Debit operating system.
-- Complete provider mirrors (customers, subscriptions, payments) + GcMandate
-- widened into a full mandate mirror. Forward-only (CLAUDE.md §19): enums are
-- append-only, columns are additive, and the one NOT NULL relaxation
-- (GcMandate.familyId) never rewrites existing rows.

-- New enums
CREATE TYPE "GcSubscriptionState" AS ENUM (
  'pending_customer_approval',
  'customer_approval_denied',
  'active',
  'finished',
  'cancelled',
  'paused',
  'unknown'
);

CREATE TYPE "GcPaymentState" AS ENUM (
  'pending_customer_approval',
  'pending_submission',
  'submitted',
  'confirmed',
  'paid_out',
  'cancelled',
  'customer_approval_denied',
  'failed',
  'charged_back',
  'unknown'
);

-- Append-only enum extension (CLAUDE.md §19)
ALTER TYPE "BackfillProvider" ADD VALUE IF NOT EXISTS 'gocardless';

-- GcMandate becomes the complete mandate mirror
ALTER TABLE "GcMandate" ALTER COLUMN "familyId" DROP NOT NULL;
ALTER TABLE "GcMandate" ADD COLUMN "gcCustomerId" TEXT;
ALTER TABLE "GcMandate" ADD COLUMN "reference" TEXT;
ALTER TABLE "GcMandate" ADD COLUMN "scheme" TEXT;
ALTER TABLE "GcMandate" ADD COLUMN "nextPossibleChargeDate" TIMESTAMP(3);
ALTER TABLE "GcMandate" ADD COLUMN "gcCreatedAt" TIMESTAMP(3);

CREATE INDEX "GcMandate_gcCustomerId_idx" ON "GcMandate"("gcCustomerId");

-- GcCustomer
CREATE TABLE "GcCustomer" (
    "id" TEXT NOT NULL,
    "gcCustomerId" TEXT NOT NULL,
    "email" TEXT,
    "givenName" TEXT,
    "familyName" TEXT,
    "companyName" TEXT,
    "contactId" TEXT,
    "familyId" TEXT,
    "gcCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "GcCustomer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GcCustomer_gcCustomerId_key" ON "GcCustomer"("gcCustomerId");
CREATE INDEX "GcCustomer_email_idx" ON "GcCustomer"("email");
CREATE INDEX "GcCustomer_contactId_idx" ON "GcCustomer"("contactId");
CREATE INDEX "GcCustomer_familyId_idx" ON "GcCustomer"("familyId");

ALTER TABLE "GcCustomer" ADD CONSTRAINT "GcCustomer_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GcCustomer" ADD CONSTRAINT "GcCustomer_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- GcSubscription
CREATE TABLE "GcSubscription" (
    "id" TEXT NOT NULL,
    "gcSubscriptionId" TEXT NOT NULL,
    "gcMandateId" TEXT,
    "gcCustomerId" TEXT,
    "name" TEXT,
    "status" "GcSubscriptionState" NOT NULL DEFAULT 'unknown',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "intervalUnit" TEXT NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "dayOfMonth" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "nextChargeAt" TIMESTAMP(3),
    "nextChargeMinor" INTEGER,
    "metadata" JSONB,
    "gcCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "GcSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GcSubscription_gcSubscriptionId_key" ON "GcSubscription"("gcSubscriptionId");
CREATE INDEX "GcSubscription_status_idx" ON "GcSubscription"("status");
CREATE INDEX "GcSubscription_gcCustomerId_idx" ON "GcSubscription"("gcCustomerId");
CREATE INDEX "GcSubscription_gcMandateId_idx" ON "GcSubscription"("gcMandateId");

-- GcPayment
CREATE TABLE "GcPayment" (
    "id" TEXT NOT NULL,
    "gcPaymentId" TEXT NOT NULL,
    "gcMandateId" TEXT,
    "gcCustomerId" TEXT,
    "gcSubscriptionId" TEXT,
    "status" "GcPaymentState" NOT NULL DEFAULT 'unknown',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "description" TEXT,
    "chargeDate" TIMESTAMP(3),
    "gcCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "GcPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GcPayment_gcPaymentId_key" ON "GcPayment"("gcPaymentId");
CREATE INDEX "GcPayment_status_idx" ON "GcPayment"("status");
CREATE INDEX "GcPayment_gcCustomerId_idx" ON "GcPayment"("gcCustomerId");
CREATE INDEX "GcPayment_gcSubscriptionId_idx" ON "GcPayment"("gcSubscriptionId");
CREATE INDEX "GcPayment_chargeDate_idx" ON "GcPayment"("chargeDate");
