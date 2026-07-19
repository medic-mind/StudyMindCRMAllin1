-- Direct Debit case automated chasing (ADR 0045). Person-level manual cases
-- (gcSubscriptionId becomes nullable), per-case channel flags + contact
-- details + staff-pasted re-signup link, escalation cadence state, and the
-- per-message history table. Forward-only.

ALTER TABLE "DirectDebitCase" ALTER COLUMN "gcSubscriptionId" DROP NOT NULL;

ALTER TABLE "DirectDebitCase"
  ADD COLUMN "autoChase" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sendEmails" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sendTexts" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "chaseEmail" TEXT,
  ADD COLUMN "chasePhoneE164" TEXT,
  ADD COLUMN "setupLinkUrl" TEXT,
  ADD COLUMN "cadenceDays" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "escalationStep" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAutoMessageAt" TIMESTAMP(3),
  ADD COLUMN "nextAutoMessageAt" TIMESTAMP(3);

CREATE INDEX "DirectDebitCase_nextAutoMessageAt_idx"
  ON "DirectDebitCase"("nextAutoMessageAt");

CREATE TABLE "DdCaseMessage" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "templateId" TEXT,
  "step" INTEGER NOT NULL,
  "toAddress" TEXT NOT NULL,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'sent',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DdCaseMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DdCaseMessage_caseId_createdAt_idx"
  ON "DdCaseMessage"("caseId", "createdAt");

ALTER TABLE "DdCaseMessage"
  ADD CONSTRAINT "DdCaseMessage_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "DirectDebitCase"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
