-- Companies (CLAUDE.md §4): tag each contact / family with its sister brand.
-- All additive, no backfill.
CREATE TYPE "Company" AS ENUM (
    'medic_mind',
    'oxbridge_mind',
    'study_mind'
);

ALTER TABLE "Contact" ADD COLUMN "company" "Company";
ALTER TABLE "Family"  ADD COLUMN "company" "Company";

CREATE INDEX "Contact_company_idx" ON "Contact"("company");
CREATE INDEX "Family_company_idx"  ON "Family"("company");

-- Multi-mailbox per agent (CLAUDE.md §14): the original GmailMailbox row was
-- keyed by agentId (one mailbox per agent). Repoint the PK to id so agents
-- can connect more than one Gmail account. The currently-attached row stays
-- attached and becomes the default outbound mailbox.
ALTER TABLE "GmailMailbox" ADD COLUMN "id" TEXT;
ALTER TABLE "GmailMailbox" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing rows get id = agentId and become the default mailbox.
UPDATE "GmailMailbox" SET "id" = "agentId", "isDefault" = true WHERE "id" IS NULL;

ALTER TABLE "GmailMailbox" ALTER COLUMN "id" SET NOT NULL;

ALTER TABLE "GmailMailbox" DROP CONSTRAINT "GmailMailbox_pkey";
ALTER TABLE "GmailMailbox" ADD  CONSTRAINT "GmailMailbox_pkey" PRIMARY KEY ("id");

CREATE INDEX "GmailMailbox_agentId_idx" ON "GmailMailbox"("agentId");
