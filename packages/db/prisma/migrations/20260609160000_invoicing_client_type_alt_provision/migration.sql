-- Add the "alt_provision" (Alternative Provision / council) client type to the
-- invoice mirror so an AP-billed invoice raised from the CRM keeps full fidelity
-- on `InvoicingInvoice.clientType` instead of falling back to `unknown`
-- (ADR 0036). Enums are append-only in Postgres (CLAUDE.md §19).

ALTER TYPE "InvoicingClientType" ADD VALUE IF NOT EXISTS 'alt_provision';
