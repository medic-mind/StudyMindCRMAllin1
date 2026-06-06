-- Track when a payment reminder (chaser) was last sent from the CRM, mirroring
-- `lastEmailedAt` for the initial send. The B2B Invoices Platform has no
-- dedicated "last reminded" field, so the CRM stamps it locally at send time
-- (ADR 0036). Forward-only, nullable (CLAUDE.md §19.1).

ALTER TABLE "InvoicingInvoice" ADD COLUMN "lastReminderAt" TIMESTAMP(3);
