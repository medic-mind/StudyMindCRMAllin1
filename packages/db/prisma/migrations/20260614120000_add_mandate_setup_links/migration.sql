-- ADR 0038 amendment: automated Direct Debit sign-up emails.
-- Durable setup links (we never email a ~30-minute GoCardless redirect-flow
-- URL — we email a CRM token URL and mint a fresh flow per click), plus the
-- intent → link backref so completion closes the link and stops reminders.
-- Forward-only (CLAUDE.md §19): additive table + nullable column.

ALTER TABLE "MandateIntent" ADD COLUMN "setupLinkId" TEXT;
CREATE INDEX "MandateIntent_setupLinkId_idx" ON "MandateIntent"("setupLinkId");

CREATE TABLE "MandateSetupLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "emailTo" TEXT,
    "emailedAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "gcMandateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MandateSetupLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MandateSetupLink_token_key" ON "MandateSetupLink"("token");
CREATE INDEX "MandateSetupLink_status_expiresAt_idx" ON "MandateSetupLink"("status", "expiresAt");
CREATE INDEX "MandateSetupLink_contactId_idx" ON "MandateSetupLink"("contactId");
CREATE INDEX "MandateSetupLink_familyId_idx" ON "MandateSetupLink"("familyId");

ALTER TABLE "MandateSetupLink" ADD CONSTRAINT "MandateSetupLink_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MandateSetupLink" ADD CONSTRAINT "MandateSetupLink_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
