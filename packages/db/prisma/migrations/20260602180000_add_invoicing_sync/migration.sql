-- B2B Invoices Platform sync (b2b.studymind.co.uk). Live two-way mirror.
-- CLAUDE.md §2 (idempotency), §6 (correlation), §19 (money in minor units),
-- §21 (secrets encrypted at rest).
--
-- Every mirror row dedupes on the invoicing-side id (`invoicingId`) so the
-- three inbound channels (webhook, SSE, events-feed reconcile) converge
-- idempotently. Customer/invoice/payment correlate back to CRM rows via
-- optional FKs that null out on delete (we never cascade-delete CRM data
-- from an external mirror).

-- CreateEnum
CREATE TYPE "InvoicingCustomerCategory" AS ENUM ('b2b', 'b2c', 'alt_provision', 'unknown');

-- CreateEnum
CREATE TYPE "InvoicingCustomerStatus" AS ENUM ('active', 'on_hold', 'archived', 'unknown');

-- CreateEnum
CREATE TYPE "InvoicingInvoiceStatus" AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled', 'unknown');

-- CreateEnum
CREATE TYPE "InvoicingClientType" AS ENUM ('uk_b2b', 'school', 'summer_school', 'international', 'unknown');

-- CreateTable
CREATE TABLE "InvoicingCustomer" (
    "id" TEXT NOT NULL,
    "invoicingId" TEXT NOT NULL,
    "category" "InvoicingCustomerCategory" NOT NULL DEFAULT 'unknown',
    "status" "InvoicingCustomerStatus" NOT NULL DEFAULT 'unknown',
    "companyName" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactEmailCc" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "country" TEXT,
    "vatNumber" TEXT,
    "service" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "businessAccountId" TEXT,
    "contactId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastEventSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "InvoicingCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicingInvoice" (
    "id" TEXT NOT NULL,
    "invoicingId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "customerId" TEXT,
    "invoicingPartnerId" TEXT,
    "status" "InvoicingInvoiceStatus" NOT NULL DEFAULT 'unknown',
    "clientType" "InvoicingClientType" NOT NULL DEFAULT 'unknown',
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "vatTotalMinor" INTEGER NOT NULL DEFAULT 0,
    "grandTotalMinor" INTEGER NOT NULL DEFAULT 0,
    "paidMinor" INTEGER NOT NULL DEFAULT 0,
    "pricesIncludeVat" BOOLEAN,
    "issueDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "paymentTerms" TEXT,
    "poNumber" TEXT,
    "paymentReference" TEXT,
    "billToName" TEXT,
    "fromEmail" TEXT,
    "notes" TEXT,
    "internalNotes" TEXT,
    "lastEmailedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastEventSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "InvoicingInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicingLineItem" (
    "id" TEXT NOT NULL,
    "invoicingId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "vatRate" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoicingLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicingPayment" (
    "id" TEXT NOT NULL,
    "invoicingId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "method" TEXT,
    "reference" TEXT,
    "paidAt" TIMESTAMP(3),
    "lastEventSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "InvoicingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicingSetting" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "baseUrl" TEXT NOT NULL DEFAULT 'https://b2b.studymind.co.uk',
    "apiKeyCiphertext" BYTEA,
    "apiKeyIv" BYTEA,
    "apiKeyDekCiphertext" BYTEA,
    "apiKeyAad" BYTEA,
    "apiKeyKeyVersion" INTEGER,
    "apiKeyLast4" TEXT,
    "webhookSecretCiphertext" BYTEA,
    "webhookSecretIv" BYTEA,
    "webhookSecretDekCiphertext" BYTEA,
    "webhookSecretAad" BYTEA,
    "webhookSecretKeyVersion" INTEGER,
    "eventsCursor" TEXT,
    "streamCursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "InvoicingSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoicingCustomer_invoicingId_key" ON "InvoicingCustomer"("invoicingId");

-- CreateIndex
CREATE INDEX "InvoicingCustomer_businessAccountId_idx" ON "InvoicingCustomer"("businessAccountId");

-- CreateIndex
CREATE INDEX "InvoicingCustomer_contactId_idx" ON "InvoicingCustomer"("contactId");

-- CreateIndex
CREATE INDEX "InvoicingCustomer_category_idx" ON "InvoicingCustomer"("category");

-- CreateIndex
CREATE INDEX "InvoicingCustomer_status_idx" ON "InvoicingCustomer"("status");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicingInvoice_invoicingId_key" ON "InvoicingInvoice"("invoicingId");

-- CreateIndex
CREATE INDEX "InvoicingInvoice_customerId_idx" ON "InvoicingInvoice"("customerId");

-- CreateIndex
CREATE INDEX "InvoicingInvoice_invoicingPartnerId_idx" ON "InvoicingInvoice"("invoicingPartnerId");

-- CreateIndex
CREATE INDEX "InvoicingInvoice_status_idx" ON "InvoicingInvoice"("status");

-- CreateIndex
CREATE INDEX "InvoicingInvoice_invoiceNumber_idx" ON "InvoicingInvoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicingLineItem_invoicingId_key" ON "InvoicingLineItem"("invoicingId");

-- CreateIndex
CREATE INDEX "InvoicingLineItem_invoiceId_idx" ON "InvoicingLineItem"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicingPayment_invoicingId_key" ON "InvoicingPayment"("invoicingId");

-- CreateIndex
CREATE INDEX "InvoicingPayment_invoiceId_idx" ON "InvoicingPayment"("invoiceId");

-- AddForeignKey
ALTER TABLE "InvoicingCustomer" ADD CONSTRAINT "InvoicingCustomer_businessAccountId_fkey" FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicingCustomer" ADD CONSTRAINT "InvoicingCustomer_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicingInvoice" ADD CONSTRAINT "InvoicingInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "InvoicingCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicingLineItem" ADD CONSTRAINT "InvoicingLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "InvoicingInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicingPayment" ADD CONSTRAINT "InvoicingPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "InvoicingInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
