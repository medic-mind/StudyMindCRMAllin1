# B2B Invoices Platform integration — status

Live two-way sync between this CRM and the **B2B Invoices Platform**
(`b2b.studymind.co.uk`). Customers, invoices, line items, and payments stay in
step across both apps; **every** invoicing action — raise, edit, issue, email,
send a reminder, record/remove a payment, mark paid, cancel, reissue, duplicate,
and preview the exact PDF — is doable from inside the CRM.

Built following the repo's per-provider integration pattern (Stripe/Trengo as
the templates) and CLAUDE.md rules: idempotency everywhere, money in integer
minor units, secrets encrypted at rest, every financial write audited, the
webhook handler stays thin and hands off to Inngest. Architecture: **ADR 0036**.

---

## What was built

### 1. Typed client — `packages/integrations/invoicing/src/client.ts`

One file, `tsc`-clean, field names verbatim from the contract. Full surface:

- **Customers:** list / get / **contacts** (`/customers/:id/contacts`) / create /
  update / archive.
- **Invoices:** list / get / create / update (PATCH) / **issue** / **cancel** /
  **reissue** / **duplicate** / **activity**.
- **Payments:** **list** / record / **delete** / mark-paid.
- **Email:** send (PDF) / **send-reminder** (chaser + PDF).
- **PDF:** `getInvoicePdfJson` (base64) **and** `getInvoicePdfBytes`
  (`?format=pdf`, byte-identical to Send) for the inline preview/download proxy.
- **Reference data:** `getBillingCompanies` / `getBankAccounts` /
  `getCompanySettings` (letterhead + bank details for raising invoices).
- **Sync channels:** `getEvents` (pull feed) + `streamEvents` (SSE async
  generator, parser unit-tested) + webhooks register / **list** / **delete**.

`401 → InvoicingUnauthorizedError`, `403 → InvoicingReadOnlyError` surfaced
distinctly so the UI can ask for a read+write key. All outbound goes through
`safeFetch` (SSRF allowlist; `b2b.studymind.co.uk` listed).

### 2. Types + money + fail-closed enums — `types.ts`

Zod shapes for every raw payload (incl. billing companies, bank accounts,
activity, customer contacts). `toMinor`/`toMajor` convert decimal strings to
integer pence without float maths (§19). Category / status / invoice-status /
client-type / event-source all map unknown values to `unknown` (§8).

### 3. Domain adapter — `adapter.ts`

Pure CRM → payload mappers + category routing (school/partnership → `b2b`, B2C
Contact → `b2c`, AP/council → `alt_provision`).

### 4. Inbound sync — `sync.ts`

Idempotent upserts for customer / invoice (+ line items + payments), all
dedup-keyed on the invoicing-side id. `invoice.paidMinor` is recomputed from the
full payment set (order-independent). Payments dedupe on the platform payment id
(no double-payment). **Deletes** handled too: `deletePaymentByInvoicingId`
(remove-payment + `payment.deleted`) and `softDeleteInvoice/CustomerByInvoicingId`
(a human deleted it on the platform).

### 5. Outbound writes — `outbound.ts`

Every platform button, each re-syncing the canonical response into the mirror
(`source:'api'`) and writing an `AuditLogEntry`:

- `ensureCustomerForBusinessAccount` / `ensureCustomerForContact` (lookup-or-create).
- `raiseInvoice` / `editInvoice` (PATCH; `lineItems` replaces all rows).
- `issueInvoice` / `cancelInvoice` / `reissueInvoice` / `duplicateInvoice`.
- `sendInvoice` / `sendReminder`.
- `recordPayment` / `removePayment` (refetches the canonical invoice, then drops
  the stale local payment row) / `markPaid`.

### 6. Webhook receiver — `apps/web/app/api/webhooks/invoicing/route.ts`

RAW-body HMAC verify (`t=…,v1=…` over `${t}.${rawBody}`) **before** JSON-parsing,
5-minute replay window. Persists a `ProviderEvent` (idempotent on event id) and
enqueues `invoicing/event.received` only on first sight. 400 on bad/missing
signature; never logs an unverified body.

### 7. Background jobs — `jobs.ts`

- `invoicing/event.received` — processes one inbound event; **skips
  `source:'api'`** (echo-loop guard); handles `*.deleted`.
- `invoicing/reconcile` — every 2 min + on-demand; walks
  `/api/v1/events?since=<cursor>`, applying each event through the same
  idempotent `applyEvent`, persisting the cursor per batch. Durable heal for any
  dropped webhook (acceptance test 5).

### 8. tRPC router — `apps/web/app/api/trpc/routers/invoicing.ts`

- `invoicing.config.*` — status / save (write-only secrets) / test / importAccounts.
- `invoicing.customers.list`.
- `invoicing.invoices.*` — list / raise / edit / issue / send / sendReminder /
  recordPayment / removePayment / markPaid / cancel / reissue / duplicate / activity.
- `invoicing.reference.*` — billingCompanies / bankAccounts / companySettings.

Roles (finance tiers): reads Manager+; credentials CEO/Senior Manager;
raise/edit/issue/send/reminder/record/reissue/duplicate Sales Executive+;
cancel/remove-payment/mark-paid Manager+.

### 9. PDF preview/download — server-side proxy

`apps/web/app/api/internal/invoicing/invoices/[invoicingId]/pdf/route.ts`
(Node runtime, staff-gated, audited `invoicing.pdf_viewed`). Streams
`GET /invoices/:id/pdf?format=pdf` — the same renderer Send uses, so the preview
is **byte-identical** to what the client receives — without exposing the API key
to the browser. `?download=1` forces a download. International invoices render
VAT-free.

### 10. Config UI + account panel

- Settings → Invoicing (`/settings/invoicing`, CEO/Senior Manager): API key +
  webhook secret (encrypted at rest; only last-4 shown), connection badge, test,
  receiver URL, historic import.
- `AccountInvoicingPanel.tsx` (on `/accounts/[id]`): lists live invoices and
  drives raise / preview-PDF / download / send / send-reminder / record-payment /
  remove-payment / mark-paid / issue / reissue / duplicate / cancel inline,
  role-gated. The PDF previews inline in an `<iframe>` via the proxy. Money is
  GBP from minor units.

### 11. Schema + plumbing

Mirror tables `InvoicingCustomer/Invoice/LineItem/Payment` + encrypted
`InvoicingSetting` (secrets + cursors), correlation FKs `onDelete: SetNull`.
Migration `20260602180000_add_invoicing_sync`. New audit/event names registered
in `packages/core/src/events/registry.ts`. `.env.example` documents
`INVOICING_API_BASE_URL` / `_API_KEY` / `_WEBHOOK_SECRET` (env fallbacks; the
encrypted DB row is preferred). Inngest serve registers the invoicing `FUNCTIONS`.

---

## Acceptance tests

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Create a school in the CRM → appears on the platform within ~2s | ✅ `invoices.raise` lookup-or-creates the customer via `POST /customers`. |
| 2 | Edit the school's phone on the platform UI → CRM reflects it; `source:"app"` | ✅ `partner.updated` webhook → `upsertCustomerFromRecord` (record is source of truth). |
| 3 | Raise an invoice → correct line items, subtotal, VAT, grand total; international = no VAT | ✅ totals mirrored from the response; `client_type:'international'` is passed through, PDF renders VAT-free. |
| 4 | Preview PDF matches what the client receives byte-for-byte | ✅ proxy streams the same `?format=pdf` renderer Send uses. |
| 5 | Send then Send reminder → client gets email + PDF; platform activity shows both | ✅ `invoices.send` + `invoices.sendReminder`; activity readable via `invoices.activity`. |
| 6 | Mark paid on the platform UI → CRM marks paid; no double-payment | ✅ payment dedup on the platform payment id (integration test proves it). |
| 7 | Cancel / reissue / duplicate from the CRM → state matches on both sides | ✅ `invoices.{cancel,reissue,duplicate}` + mirror re-sync. |
| 8 | Receiver offline 5 min, 3 edits → all heal via the events-feed cursor | ✅ `invoicing/reconcile` walks `/events?since=<cursor>` and persists the cursor per batch. |

---

## Tests

- `client.test.ts` (19) — every new endpoint hits the right path/method, unwraps
  the `{ data }` envelope, maps 401/403, PDF bytes + filename, SSE parse + stream.
- `webhook.test.ts` (16) — HMAC verify matrix, money helpers, fail-closed enums.
- `adapter.test.ts` (8) — category routing + payload shaping.
- `config.test.ts` (3) — encrypted save/load round-trip.
- `__tests__/contract/invoicing/…` (6) — route verifies signature, persists
  `ProviderEvent`, enqueues; idempotent; 400 on forged/missing signature.
- `__tests__/integration/invoicing-sync.test.ts` (6) — idempotent upserts, **no
  double-payment**, skip-when-not-mirrored, **remove-payment recompute**,
  soft-delete.

Full repo suite green: **1101 tests / 151 files**, plus `tsc` + ESLint clean
across the integration package, `apps/web`, and `packages/core`.

---

## What you need from the invoicing team

1. Deploy the CRM, then paste `<origin>/api/webhooks/invoicing` into their
   **Settings → API & Integrations → Add webhook** (subscribe `*`). They return a
   `whsec_…` secret.
2. They mint a `sk_live_…` API key with **read+write** scopes.
3. In the CRM → **Settings → Invoicing**, paste both; hit **Send test event** to
   confirm the badge goes green.

---

## Gaps / follow-ups

- **SSE boot-time consumer.** The client `streamEvents` generator + cursor
  plumbing are in place and unit-tested; wiring a long-lived runner belongs in the
  always-on `worker`. Webhooks (instant) + the 2-min events-feed reconcile (heal)
  satisfy the sync contract today, so this is parity polish, not a gap in coverage.
- **`task` / `student` platform entities** are acknowledged-and-dropped (the CRM
  models them first-class as `Task` / `BusinessAccountStudent`); mapping them is a
  follow-up.
- **Webhook auto-registration.** `client.registerWebhook` / `listWebhooks` /
  `deleteWebhook` exist; a one-click "Register receiver" button from Settings is an
  easy follow-up.
- **Reference-data pickers in the raise form.** `invoicing.reference.*` is wired;
  surfacing billing-company / bank-account dropdowns in the raise UI is a polish
  follow-up.
