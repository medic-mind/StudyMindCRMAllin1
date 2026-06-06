# ADR 0036 — B2B Invoices Platform two-way sync

- Status: Accepted
- Date: 2026-06-06

## Context

StudyMind runs a separate **B2B Invoices Platform** (`b2b.studymind.co.uk`) that
holds customers (schools / B2B partners / B2C individuals / Alternative-Provision
council clients), invoices, line items, and payments, and renders + emails the
invoice PDFs. The platform exposes a complete API-key-authenticated REST surface
(`/api/v1/*`) plus three inbound channels (webhooks, an SSE stream, and a
durable events feed).

The ask: make the two apps stay in **live two-way sync** so every invoicing
action — raise, edit, issue, email, send a reminder, record/remove a payment,
mark paid, cancel, reissue, duplicate, and preview the exact PDF — is doable from
*inside this CRM*, with no echo loops and no data loss.

We already model B2B accounts (`BusinessAccount`) and B2C customers (`Contact`);
the CRM must reuse those, not create a parallel customer list. We must not break
the existing `UploadedInvoice` feature (manually-uploaded invoice *files*), which
is unrelated — this is a live mirror of the platform's *first-class* invoices.

## Decision

Build a standard per-provider integration (`packages/integrations/invoicing/`)
following the Stripe/Trengo template and CLAUDE.md rules (idempotency, money in
integer minor units, secrets encrypted, every financial write audited, thin
webhook → Inngest).

1. **Mirror tables, dedup-keyed on the platform id.** `InvoicingCustomer`,
   `InvoicingInvoice`, `InvoicingLineItem`, `InvoicingPayment` each carry a
   unique `invoicingId`; every inbound channel funnels through the same `sync.ts`
   upserts so a webhook + an SSE frame + a feed row for one change converge to a
   single row. Money is stored in pence (`toMinor`/`toMajor` convert at the
   boundary). Correlation: customers link to an optional `BusinessAccount`
   (schools/partnerships/AP) or `Contact` (B2C); the platform id is cached on the
   row at lookup-or-create so the two sides stay linked.

2. **Three channels, one taxonomy.** REST out; webhooks (HMAC over the raw body,
   5-minute replay window) for instant push; the `/events?since=<cursor>` feed
   walked by `invoicing/reconcile` (every 2 min) as the durable heal for any
   dropped webhook. The SSE `streamEvents` client method is implemented for
   parity; a boot-time long-lived consumer is deferred to the always-on `worker`
   because webhooks + the 2-min reconcile already satisfy the contract.

3. **Echo-loop suppression by `source`.** Every event carries `source` ∈
   `api | app | system`. The CRM's own writes set `source:'api'` synchronously
   into the mirror; the inbound job **skips `source==='api'`** so it never
   re-applies (or re-audits) its own writes. Human edits on the platform arrive
   as `source:'app'` and are mirrored within ~1s.

4. **Full action surface, audited.** `outbound.ts` wraps every platform button —
   raise / edit / issue / send / send-reminder / record-payment / remove-payment
   / mark-paid / cancel / reissue / duplicate — refetching the canonical invoice
   where state is recomputed (payments) per CLAUDE.md §8 (the API is the source of
   truth), and writing an `AuditLogEntry` for each. tRPC `invoicing.*` exposes
   them with finance-tier roles (Sales Executive+ for create-ish actions;
   Manager+ for cancel / remove-payment / mark-paid). Deletes on the platform
   (`payment.deleted`, and soft-delete for invoice/customer) are handled inbound.

5. **PDF preview/download via a backend proxy.** `GET /invoices/:id/pdf?format=pdf`
   is the same renderer Send uses, so the preview is byte-identical to what the
   client receives. It is streamed through a staff-gated, audited internal route
   (`/api/internal/invoicing/invoices/[invoicingId]/pdf`) so the API key never
   reaches the browser; the account panel embeds it in an `<iframe>`.

6. **Encrypted credentials + self-service config.** The API key (`sk_live_…`) and
   webhook secret (`whsec_…`) are envelope-encrypted at rest in `InvoicingSetting`
   (KMS when configured, else the local AES-256 key), falling back to env vars for
   a Railway-only deploy. Settings → Invoicing pastes both, shows a connection
   badge (`GET /api/v1/`), and exposes the receiver URL to register on the
   platform.

## Consequences

- Staff bill and chase from one place; the platform's UI still works and stays in
  step. No double-entry, no ghost customer list.
- Reconciliation against Stripe/GoCardless (the §6.3 triangle) can later consume
  these mirrored invoices/payments; this ADR only establishes the sync.
- `task` and `student` platform entities are acknowledged-and-dropped for now (the
  CRM models them first-class as `Task` / `BusinessAccountStudent`); wiring them
  is a follow-up. The SSE boot-time consumer is the other deferred item.
- New audit/event names registered in `packages/core/src/events/registry.ts`
  (`invoicing.invoice_issued/_edited/_cancelled/_reissued/_duplicated`,
  `invoicing.reminder_sent`, `invoicing.payment_removed`, `invoicing.pdf_viewed`).

## Follow-up: full raise/edit parity

A second pass brought the CRM's raise/edit screen to parity with the B2B site:

- **Every write field** is exposed: the five client types (incl.
  `alt_provision` — added to the `InvoicingClientType` enum), the VAT-mode toggle
  (`prices_include_vat`), billing company + bank account (from the reference
  reads, default-selecting `is_default`), currency, issue/due dates, bill-to
  override, PO number, from-email, payment reference (defaults to the invoice
  number without dashes), payment terms, and printed + internal notes.
  International is forced VAT-free (every line `vat_rate: 0`,
  `prices_include_vat: false`, VAT inputs hidden).
- **Adjustments / already-paid** are modelled exactly as the B2B site does — as
  payments whose `reference` is the human description — so they render as
  deduction lines and auto-advance status. Recorded after the raise via the same
  `recordPayment` path (now with `payment_date`).
- **Compose-before-send**: Email/Reminder open a modal with editable
  to/cc/subject/body before POSTing to `/send` / `/send-reminder`.
- **PDF preview under strict CSP**: the app sends `X-Frame-Options: DENY` +
  `frame-ancestors 'none'` on its own responses, so the iframe is fed a `blob:`
  (no frame headers) fetched through the backend proxy; `frame-src 'self' blob:`
  admits it. The key never reaches the browser.
- **Reminder timestamp**: `lastReminderAt` (new column) is stamped on send and
  surfaced on the row, mirroring `lastEmailedAt`.
