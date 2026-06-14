-- Direct Debit recovery cases (ADR 0038, seventh amendment). One per plan that
-- cancelled/finished underpaid from go-live onward — the workflow an agent
-- drives to recover the shortfall. Soft links to the GC mirror + Contact/
-- Family/User (no DB FKs, JS-joined), matching the GC mirror pattern.
CREATE TYPE "DirectDebitCaseStatus" AS ENUM ('new', 'chasing', 'escalated', 'recovered', 'written_off');

CREATE TABLE "DirectDebitCase" (
  "id"                    TEXT NOT NULL,
  "gcSubscriptionId"      TEXT NOT NULL,
  "gcCustomerId"          TEXT,
  "contactId"             TEXT,
  "familyId"              TEXT,
  "status"                "DirectDebitCaseStatus" NOT NULL DEFAULT 'new',
  "ownerUserId"           TEXT,
  "openingShortfallMinor" INTEGER NOT NULL DEFAULT 0,
  "recoveredMinor"        INTEGER NOT NULL DEFAULT 0,
  "recoveredAt"           TIMESTAMP(3),
  "recoveryMethod"        TEXT,
  "recoveryRef"           TEXT,
  "notes"                 TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  "createdById"           TEXT,
  "updatedById"           TEXT,
  "deletedAt"             TIMESTAMP(3),
  CONSTRAINT "DirectDebitCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DirectDebitCase_gcSubscriptionId_key" ON "DirectDebitCase"("gcSubscriptionId");
CREATE INDEX "DirectDebitCase_status_idx" ON "DirectDebitCase"("status");
CREATE INDEX "DirectDebitCase_ownerUserId_idx" ON "DirectDebitCase"("ownerUserId");
CREATE INDEX "DirectDebitCase_contactId_idx" ON "DirectDebitCase"("contactId");
CREATE INDEX "DirectDebitCase_familyId_idx" ON "DirectDebitCase"("familyId");
