-- ADR 0021 — copy the agent's Gmail signature so outgoing CRM mail matches
-- what they send from Gmail. HTML, taken from users.settings.sendAs verbatim.
ALTER TABLE "MailAccount" ADD COLUMN "signatureHtml" TEXT;
ALTER TABLE "MailAccount" ADD COLUMN "signatureSyncedAt" TIMESTAMP(3);
