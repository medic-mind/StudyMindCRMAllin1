-- Audit-B2 Chunk 1: PaymentLinkIntent. CLAUDE.md §8.
--
-- One row per agent-initiated Stripe Payment Link. Persisted BEFORE the
-- Stripe SDK call so the request is recoverable across crashes; the
-- idempotency key on the Stripe call binds to PaymentLinkIntent.id so a
-- replay returns the same row. Metadata { familyId, contactId, agentId,
-- reason } flows on the Stripe payment_link so checkout.session.completed
-- reconciles cleanly (CLAUDE.md §8).

CREATE TABLE "PaymentLinkIntent" (
  "id"                    TEXT PRIMARY KEY,
  "familyId"              TEXT NOT NULL,
  "contactId"             TEXT,
  "agentId"               TEXT NOT NULL,
  "amountMinor"           INTEGER NOT NULL,
  "currency"              TEXT NOT NULL DEFAULT 'gbp',
  "reason"                TEXT NOT NULL,
  "stripePaymentLinkId"   TEXT,
  "url"                   TEXT,
  "status"                TEXT NOT NULL DEFAULT 'pending',
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  "createdById"           TEXT,
  "updatedById"           TEXT
);

CREATE INDEX "PaymentLinkIntent_familyId_idx" ON "PaymentLinkIntent" ("familyId");
CREATE INDEX "PaymentLinkIntent_agentId_idx" ON "PaymentLinkIntent" ("agentId");
CREATE INDEX "PaymentLinkIntent_stripePaymentLinkId_idx" ON "PaymentLinkIntent" ("stripePaymentLinkId");
