-- Complaints redesign (2026-07): complaints are logged in the CRM (Slack
-- auto-ingestion removed). A complaint can be logged against a CRM contact OR a
-- manually-typed person, can be archived (reversibly), and anchors a Slack
-- thread in #complaintcallsummaries.

-- contactId becomes nullable — a manual complaint has no CRM contact.
ALTER TABLE "Complaint" ALTER COLUMN "contactId" DROP NOT NULL;

-- Switch the FK from CASCADE → SET NULL so erasing a contact keeps the complaint
-- (with its typed identity snapshot), never cascade-deletes the record.
ALTER TABLE "Complaint" DROP CONSTRAINT "Complaint_contactId_fkey";
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Manual customer identity (used when contactId is null; a snapshot otherwise).
ALTER TABLE "Complaint" ADD COLUMN "personName" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "personPhone" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "personEmail" TEXT;

-- Slack thread anchor (the bot's #complaintcallsummaries post).
ALTER TABLE "Complaint" ADD COLUMN "slackChannelId" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "slackMessageTs" TEXT;

-- Reversible archive.
ALTER TABLE "Complaint" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Complaint_archivedAt_idx" ON "Complaint"("archivedAt");
