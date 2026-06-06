# @studymind/integration-invoicing

Live two-way sync with the **B2B Invoices Platform** (`b2b.studymind.co.uk`).

## Channels (all three)

| Direction              | Mechanism                         | Code                                                 |
| ---------------------- | --------------------------------- | ---------------------------------------------------- |
| CRM → invoicing        | REST `/api/v1/*`                  | `outbound.ts` via `client.ts`                        |
| invoicing → CRM (push) | webhook (HMAC) + SSE              | `webhook.ts`, `jobs.ts` (`invoicing/event.received`) |
| invoicing → CRM (heal) | `/api/v1/events?since=` pull-feed | `jobs.ts` (`invoicing/reconcile`, nightly)           |

Every event carries `source`: `api` (our own writes — **skipped on inbound** to
avoid echo loops), `app` (a human in their UI), or `system` (their automation).

## Idempotency

Every mirror row dedupes on the invoicing-side id (`invoicingId`). All three
inbound channels call the same `sync.ts` upserts, so a webhook + an SSE frame +
a nightly feed row for the same change converge to one row — and a payment is
never double-counted (dedup on the platform payment id).

## Money

The API speaks decimal strings/numbers (`"720.00"`); we store integer **minor
units** (pence) and convert at the boundary (`toMinor` / `toMajor` in
`types.ts`). No float maths on money (CLAUDE.md §19).

## Secrets

The API key (`sk_live_…`) and webhook secret (`whsec_…`) are envelope-encrypted
at rest in `InvoicingSetting` (`config.ts`), mirroring the Trengo token pattern.
They fall back to `INVOICING_API_KEY` / `INVOICING_WEBHOOK_SECRET` env vars for
a Railway-only deploy. Never logged; only the API key's last 4 chars surface in
the UI.

## Category mapping (CRM → platform `partners.category`)

| CRM record                             | category        | client_type |
| -------------------------------------- | --------------- | ----------- |
| School (BusinessAccount)               | `b2b`           | `school`    |
| Partnership (BusinessAccount)          | `b2b`           | `uk_b2b`    |
| B2C individual (Contact)               | `b2c`           | `uk_b2b`    |
| AP / council (BusinessAccount flagged) | `alt_provision` | —           |

## Invoice actions (all doable from the CRM, mirrored on the platform)

`raise` · `edit` (PATCH; `line_items` replaces all rows) · `issue` · `send`
(email + PDF) · `send reminder` (chaser + PDF) · `record payment` · `remove
payment` · `mark paid` · `cancel` (void) · `reissue` · `duplicate`. Every one
re-syncs the platform's canonical response into the mirror (`source:'api'`) and
writes an `AuditLogEntry`. Roles: raise/edit/issue/send/reminder/record/reissue/
duplicate = Sales Executive+; cancel/remove-payment/mark-paid = Manager+
(finance tier).

## PDF preview / download (no email)

`client.getInvoicePdfBytes(id)` fetches `GET /invoices/:id/pdf?format=pdf` — the
same renderer Send uses, so it is byte-identical to what the client receives.
Served through the backend proxy
`apps/web/app/api/internal/invoicing/invoices/[invoicingId]/pdf/route.ts` (staff-
gated, audited) so the API key never reaches the browser. The account panel shows
it inline in an `<iframe>` (`?download=1` forces a download). International
invoices render VAT-free.

## Reference data (read-only)

`getBillingCompanies` / `getBankAccounts` / `getCompanySettings` back the
`invoicing.reference.*` tRPC reads — used to pick the letterhead + bank details
(`billing_company_id` / `bank_account_id`) when raising an invoice.

## Files

- `client.ts` — typed REST client (verbatim field names), 401/403 surfaced
  distinctly. Full surface: customers (+contacts), invoices CRUD + lifecycle
  (issue/cancel/reissue/duplicate/activity), payments (list/record/delete),
  send/reminder, PDF (json + bytes), billing-companies/bank-accounts/company-
  settings, events feed, SSE `streamEvents`, webhooks (register/list/delete).
- `types.ts` — raw Zod shapes, domain enums (fail-closed `unknown`), money helpers.
- `webhook.ts` — HMAC verify over the RAW body (`t=,v1=`), replay window.
- `config.ts` — encrypted API key + webhook secret + cursors.
- `adapter.ts` — pure CRM→payload mappers.
- `sync.ts` — idempotent inbound upserts + deletes (customer / invoice / line
  items / payment; `payment.deleted` and soft-delete of invoice/customer).
- `outbound.ts` — every audited write listed above.
- `jobs.ts` — `invoicing/event.received` (skips `source:'api'`; handles
  `*.deleted`) + `invoicing/reconcile` (events-feed cursor heal, every 2 min).

## SSE vs webhooks (the third channel)

Webhooks give instant push; the `invoicing/reconcile` cron (every 2 min) walks
the `/events?since=<cursor>` feed as the durable, idempotent backstop that heals
any dropped webhook. `client.streamEvents()` (async generator over
`GET /api/v1/stream`) is implemented for completeness/parity; a boot-time
long-lived consumer belongs in the always-on `worker` process and is the one
deferred piece — webhooks + the 2-min reconcile already satisfy the sync
contract (and acceptance test 5).

## Setup

1. Deploy the CRM; the receiver lives at `/api/webhooks/invoicing`.
2. In the invoicing platform → Settings → API & Integrations → Add webhook,
   paste that URL. They return a `whsec_…` secret.
3. In the CRM → Settings → Invoicing, paste the `sk_live_…` API key and the
   `whsec_…` secret. The connection badge calls `GET /api/v1/` to confirm.
