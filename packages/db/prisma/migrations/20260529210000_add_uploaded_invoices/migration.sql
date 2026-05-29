-- Uploaded invoices — manually uploaded invoice files attached to a
-- BusinessAccount (B2B / Schools / Partners), a Family (normal customer),
-- or a Contact (lead / one-off). Different from the auto-mirrored `Invoice`
-- table which tracks Stripe / GoCardless reconciliation rows.
--
-- Forward-only (CLAUDE.md §19). File bytes live inline (same trade-off as
-- ContactDocument and CallSummaryTemplate per §4 — self-hosted installs
-- need no S3).

-- 1. Status enum.
CREATE TYPE "UploadedInvoiceStatus" AS ENUM (
    'draft',
    'sent',
    'paid',
    'overdue',
    'void'
);

-- 2. UploadedInvoice table.
CREATE TABLE "UploadedInvoice" (
    "id"                TEXT NOT NULL,
    "businessAccountId" TEXT,
    "contactId"         TEXT,
    "familyId"          TEXT,
    "invoiceNumber"     TEXT,
    "amountMinor"       INTEGER,
    "currency"          TEXT NOT NULL DEFAULT 'GBP',
    "issuedAt"          TIMESTAMP(3),
    "dueAt"             TIMESTAMP(3),
    "status"            "UploadedInvoiceStatus" NOT NULL DEFAULT 'draft',
    "notes"             TEXT,
    "fileName"          TEXT NOT NULL,
    "contentType"       TEXT NOT NULL,
    "byteSize"          INTEGER NOT NULL,
    "data"              BYTEA NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    "createdById"       TEXT,
    "updatedById"       TEXT,
    "archivedAt"        TIMESTAMP(3),
    CONSTRAINT "UploadedInvoice_pkey" PRIMARY KEY ("id"),
    -- Exactly one owner FK must be set. Enforced at the DB layer so a bad
    -- caller can't bypass the tRPC validation.
    CONSTRAINT "UploadedInvoice_owner_exactly_one" CHECK (
        (("businessAccountId" IS NOT NULL)::int +
         ("contactId" IS NOT NULL)::int +
         ("familyId" IS NOT NULL)::int) = 1
    )
);

CREATE INDEX "UploadedInvoice_businessAccountId_idx"
    ON "UploadedInvoice"("businessAccountId");
CREATE INDEX "UploadedInvoice_contactId_idx" ON "UploadedInvoice"("contactId");
CREATE INDEX "UploadedInvoice_familyId_idx" ON "UploadedInvoice"("familyId");
CREATE INDEX "UploadedInvoice_status_idx" ON "UploadedInvoice"("status");
CREATE INDEX "UploadedInvoice_archivedAt_idx" ON "UploadedInvoice"("archivedAt");

ALTER TABLE "UploadedInvoice"
    ADD CONSTRAINT "UploadedInvoice_businessAccountId_fkey"
    FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UploadedInvoice"
    ADD CONSTRAINT "UploadedInvoice_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UploadedInvoice"
    ADD CONSTRAINT "UploadedInvoice_familyId_fkey"
    FOREIGN KEY ("familyId") REFERENCES "Family"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
