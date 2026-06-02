# ADR 0030 — Stripe payment recording + product classification

- Status: Accepted
- Date: 2026-06-04

## Context

The Stripe integration mirrored subscriptions and failed invoices
(`customer.subscription.updated`, `invoice.payment_failed`) but did **not**
record successful payments, and we had no way to capture *what* a payment was
for. Product/finance asked for: a payment to land against the right paying
party, and the nature of the purchase recorded without creating duplicate
product records.

## Decision

1. **Record successful payments off `charge.succeeded`.** The Stripe charge id
   is the canonical, de-duplicated money-movement id and becomes
   `Payment.externalId`. We record payments off charges only — not off
   `invoice.paid` / `payment_intent.succeeded` — so a single payment is never
   double-counted across overlapping event types.
   `syncStripePayment` (in `packages/core/src/finance/sync-stripe.ts`) is
   idempotent on the charge id and links the mirrored `Invoice` when present.

2. **Reverse on `charge.refunded`** via `revertStripePayment`, flipping
   `Payment.reverted` so reconciliation re-opens allocations — the same shape as
   the GoCardless late-failure reversal (CLAUDE.md §9).

3. **Respect "no auto-create" (CLAUDE.md §3).** Payments for a Stripe customer
   with no `StripeCustomer → Family` mapping return `unresolved` and are
   surfaced for a human to link — exactly as the existing subscription/invoice
   paths do. We do **not** invent a Family/Contact from a payment.

4. **Classify the product against the existing catalogue.**
   `classifyProductFromText` matches a charge's description/metadata against
   active `ProductCatalogueItem` rows (handle + name + aliases, word-boundary
   phrase match — the same deterministic approach as the lead classifier,
   ADR 0023). It never creates a product; an unmatched charge is recorded with
   `productUnmatched: true` for a human to label. The result is stored on the
   `payment` Interaction payload (`productHandles`, `productCategories`).

## Consequences

- Successful payments now appear on the Family timeline with the products they
  bought, and refunds flip status — closing a real reconciliation gap.
- No schema change: reuses `Payment`, `Invoice`, `ProductCatalogueItem`,
  `Interaction`.
- Auto-creating a Contact/Family from an unknown payer (a different product
  ask) deliberately remains out of scope — it contradicts the no-auto-create
  rule and would need its own ADR + a human-confirmed merge surface.

## Follow-ups

- ~~Surface unresolved Stripe payments in a finance tray.~~ **Done** — a
  successful charge with no `StripeCustomer → Family` mapping is recorded in
  `UnresolvedStripePayment` and listed at `/finance/unresolved-payments`
  (Manager+). A human links it to a Family (which records the `Payment` and
  creates the `StripeCustomer` mapping so future charges auto-resolve) or
  dismisses it with a reason. Domain: `packages/core/src/finance/unresolved-payments.ts`;
  tRPC `finance.unresolvedPayments.{list,resolve,dismiss}` + `family.search`.
  Still human-confirmed — never an auto-created Family (CLAUDE.md §3).
- Optional AI pass to refine low-confidence / unmatched product classification.
- Line-item-level classification for multi-product checkout sessions.
