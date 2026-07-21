# ADR 0048 — Pick up purchases from payment-alert emails (no Stripe API) and auto-enrol

Date: 2026-07-21
Status: accepted
Relates to: ADR 0031 (weekly-classes auto-enrolment), ADR 0032 (Google Voice
email ingestion — the pattern this reuses).

## Context

Weekly-class enrolment (ADR 0031) detects payers by calling the **live Stripe
API** every night (`stripe.subscriptions.list`). The operator wants the CRM to
**keep Stripe as the processor but stop reading it via the API** — the API key
in the CRM is the security surface they want gone — and instead pick purchases
up from the **payment-alert emails** that already arrive in a connected mailbox
(info@medicmind.co.uk). The CRM's role for this is deliberately narrow:
**record-keeping + webinar service provision only** — log the purchase and enrol
the buyer into their class. No refunds, no invoices, no charges through the CRM.

## Decision

Add an email-sourced purchase path that mirrors the Google Voice ingestion
(ADR 0032) and feeds the **existing** enrolment engine — no Stripe API.

1. **Ingest (cheap gate).** In the Gmail sync `processMessage`, a message from a
   configured alert sender (`isPurchaseAlertSender`, senders from
   `PURCHASE_ALERT_SENDERS`, default `receipts@stripe.com` /
   `notifications@stripe.com`; Stripe sub-addresses match their base), behind the
   `stripe.purchase_email_ingest_enabled` operational flag, is handed off as the
   `webinar/purchase-email.received` event. Sender+flag gate means **no AI runs
   on ordinary mail** (§32). The raw alert is not also filed as a timeline email.

2. **Extract (AI, at the boundary).** `apps/web/app/api/inngest/_boundary/purchase-email.ts`
   runs the mini-tier `purchase_email` task (`packages/ai/src/prompts/purchase-email.ts`)
   to pull `{ isPurchase, buyerName, buyerEmail, productDescription, amountMinor,
   currency, billingInterval, externalRef }`. Format-tolerant: the model reads the
   whole email rather than a hardcoded layout. Idempotent on the source message
   id (the recorded purchase Interaction is the marker), so a re-sync never
   re-spends AI or double-records.

3. **Record.** Match the buyer by email (create a lightweight contact if new — a
   confirmed purchase is a real customer, the same deliberate exception the call
   and lead resolvers make). Write a `payment` Interaction (`source:'stripe_email'`)
   on the contact — the record-keeping artifact.

4. **Enrol.** `enrollFromPurchase` (added to the existing `enrollment-service.ts`)
   reuses the same engine as the Stripe scan: resolve today's cohort, run the
   deterministic subject/level matcher over the product text (AI only as a
   fallback, always `pending_review`), and `upsertEnrollment`. **Confident rule
   matches auto-activate and start the weekly emails; everything else waits for
   one click** (CLAUDE.md §3, unchanged threshold 0.8). Expiry is date-based
   (there is no live subscription to refetch): a monthly plan gets a rolling
   window each renewal email refreshes, a yearly plan ~a year, a one-off never
   auto-expires.

The deterministic matcher (`packages/core/webinar`), the AI class matcher, and
the enrolment upsert are **unchanged** — only the data source is new.

## Scope boundaries (explicit)

- **No money movement.** This path never charges, refunds, or invoices, and
  makes no Stripe API call. Existing Finance tools (refunds / payment links /
  invoicing) are untouched by this ADR.
- The Stripe **webhook** path (money-in mirror on the Family timeline) and the
  Stripe-API webinar scan remain in the code; the email path is additive and
  flag-gated. Retiring the nightly `stripe.subscriptions.list` scan in favour of
  the email source is a follow-up once the email path is proven live.

## Consequences

- Off by default: nothing happens until the receiving mailbox is connected to
  the CRM's Gmail sync AND `stripe.purchase_email_ingest_enabled` is on AND
  `PURCHASE_ALERT_SENDERS` points at the real alert sender. Kill switch is the
  same flag.
- The AI extraction was built format-tolerant and validated by unit tests on the
  deterministic sender gate; it should be validated against a real alert email
  before the flag is enabled (add that email as a fixture).
