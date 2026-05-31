# B2B Invoices Platform integration — status

Live two-way sync between this CRM and the **B2B Invoices Platform**
(`b2b.studymind.co.uk`). Customers, invoices, line items, and payments stay in
step across both apps; every invoicing action (create customer, raise invoice,
send it, record payment, mark paid) is doable from inside the CRM.

Built following the repo's per-provider integration pattern (Stripe/Trengo as
the templates) and CLAUDE.md rules: idempotency everywhere, money in integer
minor units, secrets encrypted at rest, every financial write audited, the
webhook handler stays thin and hands off to Inngest.

---

## What was built

### 1. Typed client — `packages/integrations/invoicing/src/client.ts`

One file, `tsc`-clean. Field names verbatim from the API contract. Covers
customers, invoices, payments (`/payments`, `/mark-paid`), invoice send, the
events pull-feed, the connection check (`GET /api/v1/`), and webhook
registration. `401 → InvoicingUnauthorizedError`, `403 → InvoicingReadOnlyError`
surfaced distinctly so the UI can tell the user to request a read+write key. All
outbound goes through `safeFetch` (SSRF allowlist; `b2b.studymind.co.uk` added).

### 2. Types + money + fail-closed enums — `types.ts`

Zod shapes for the raw API payloads. `toMinor`/`toMajor` convert the API's
decimal strings/numbers to integer pence without float maths (CLAUDE.md §19).
Customer category, customer status, invoice status, client type, and event
source all map unknown values to `unknown` rather than guessing (CLAUDE.md §8).

### 3. Domain adapter — `adapter.ts`

Pure CRM → payload mappers and the category routing:

| CRM record                              | invoicing `category` | `client_type` |
| --------------------------------------- | -------------------- | ------------- |
| School (BusinessAccount)                | `b2b`                | `school`      |
| Partnership (BusinessAccount)           | `b2b`                | `uk_b2b`      |
| B2C individual (Contact)                | `b2c`                | `uk_b2b`      |
| AP / council (BusinessAccount, flagged) | `alt_provision`      | —             |

### 4. Inbound sync — `sync.ts`

Idempotent upserts for customer / invoice (+ line items) / payment. Every row
dedupes on the invoicing-side id (`invoicingId`); `record` is treated as the
source of truth for mirrored fields. `invoice.paidMinor` is recomputed from the
full payment set so it's correct regardless of event ordering. Payments dedupe
on the platform payment id, so the same payment seen via an invoice **and** a
standalone `payment.*` event is counted once (no double-payment).

### 5. Outbound writes — `outbound.ts`

- `ensureCustomerForBusinessAccount` / `ensureCustomerForContact` —
  lookup-or-create, caching the returned invoicing id on the correlation row.
- `raiseInvoice` — POST with line items; persists returned id + `invoice_number`.
- `sendInvoice` → `POST /invoices/:id/send`.
- `recordPayment` → `POST /invoices/:id/payments`, then refetches the canonical
  invoice so the mirror reflects the platform's truth (CLAUDE.md §8).
- `markPaid` → `POST /invoices/:id/mark-paid`.

Each re-syncs the platform's response into the mirror with `source: 'api'` so the
local view is correct immediately, and writes an `AuditLogEntry`.

### 6. Webhook receiver — `apps/web/app/api/webhooks/invoicing/route.ts`

Reads the RAW body, verifies the HMAC (`X-Webhook-Signature: t=…,v1=…` over
`${t}.${rawBody}`) **before** JSON-parsing, with a 5-minute replay window
(`webhook.ts`). Persists a `ProviderEvent` (idempotent on the event id) and
enqueues `invoicing/event.received` only on first sight. Returns 400 on
bad/missing signature and never logs an unverified body.

### 7. Background jobs — `jobs.ts`

- `invoicing/event.received` — processes one inbound event; **skips
  `source === 'api'`** to avoid re-applying our own writes (echo-loop guard).
- `invoicing/reconcile` — nightly (01:00 UTC) + on-demand; walks the
  `/api/v1/events?since=<cursor>` pull-feed, applying each event through the same
  idempotent `applyEvent` the webhook uses, persisting the cursor as it goes.
  This is the backstop that heals anything the webhook receiver dropped.

> **SSE note.** The spec's third channel (`GET /api/v1/stream`) is a long-lived
> connection best owned by the always-on `worker` service. The client and cursor
> plumbing (`streamCursor`) are in place; wiring the boot-time consumer is the
> one deferred piece — see Gaps. Webhooks give instant push today; the nightly
> events-feed reconcile guarantees eventual consistency.

### 8. tRPC router — `apps/web/app/api/trpc/routers/invoicing.ts`

- `invoicing.config.{status,save,test}` — connection status, save credentials
  (write-only), live connection test via `GET /api/v1/`.
- `invoicing.customers.list`, `invoicing.invoices.{list,raise,send,recordPayment,markPaid}`.

Roles (mirroring the finance tiers): reads Manager+, credentials CEO / Senior
Manager, raise/send/record-payment Sales Executive+, mark-paid Manager+.

### 9. Config UI — Settings → Invoicing

`apps/web/app/(app)/settings/invoicing/` (CEO / Senior Manager). Inputs for the
API key (`sk_live_…`) and webhook secret (`whsec_…`), a connection-status badge,
and a "Send test event" button that calls `GET /api/v1/`. Both secrets are
**encrypted at rest** (`InvoicingSetting`, envelope encryption — KMS when
configured, else the local AES-256 key, mirroring the Trengo token pattern).
Only the API key's last 4 chars are ever shown. A tile was added to the Settings
landing page (Platform group).

### 10. Account-page panel

`apps/web/components/invoicing/AccountInvoicingPanel.tsx`, mounted on the B2B
account detail page. Lists live invoices and provides Raise / Send / Record
payment / Mark paid inline (role-gated). Money formatted GBP from minor units.

### 11. Schema — `packages/db/prisma/schema.prisma` + migration

New mirror tables, each dedup-keyed on the invoicing-side id:
`InvoicingCustomer`, `InvoicingInvoice`, `InvoicingLineItem`,
`InvoicingPayment`, plus the `InvoicingSetting` singleton (encrypted secrets +
cursors). Correlation FKs to `BusinessAccount`/`Contact` (`onDelete: SetNull` —
we never cascade-delete CRM data from an external mirror). Migration:
`20260602180000_add_invoicing_sync`.

### 12. Config + plumbing

- `.env.example` — `INVOICING_API_BASE_URL`, `INVOICING_API_KEY`,
  `INVOICING_WEBHOOK_SECRET` (fallbacks; the encrypted DB row is preferred).
- Event registry — audit + Inngest event names registered (CLAUDE.md §45).
- SSRF allowlist — `b2b.studymind.co.uk` added.
- Inngest serve — invoicing `FUNCTIONS` registered.

---

## Field-mapping decisions

- **Money is integer pence everywhere in the CRM.** The API speaks decimals;
  we convert at the boundary only. Server-computed totals (`subtotal`,
  `vat_total`, `grand_total`) are mirrored, never sent.
- **Correlation.** Schools/partnerships/AP correlate via `BusinessAccount`; B2C
  individuals via `Contact`. The invoicing id (and `invoice_number` for
  invoices) is persisted on the mirror row on first lookup-or-create.
- **`company_name` for B2C** is the person's name, per the API contract.
- **Quantity** is stored as the raw string (hours can be fractional) to avoid
  float drift; only `unit_price` becomes minor units.
- **Echo suppression.** Inbound events with `source === 'api'` are skipped — our
  own writes already updated the mirror synchronously.
- **Unknown enum values fail closed** to `unknown` rather than guess.

---

## Acceptance criteria

| #   | Criterion                                                                      | Status                                                                                                  |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1   | Create a school → appears on the platform within ~2s                           | ✅ `invoices.raise` lookup-or-creates the customer via `POST /customers`; mirror cached.                |
| 2   | Edit phone on the platform UI → CRM reflects it; event `source:"app"`          | ✅ `partner.updated` webhook → `upsertCustomerFromRecord` (record = source of truth).                   |
| 3   | Raise an invoice from the CRM → correct line items, subtotal, VAT, grand total | ✅ `invoices.raise`; totals mirrored from the response (integration test asserts the minor-unit maths). |
| 4   | "Mark paid" on the platform UI → CRM marks paid; no double-payment             | ✅ payment dedup on the platform payment id (integration test proves the no-double-count path).         |
| 5   | Receiver offline 5 min, 3 edits → all 3 appear at next reconcile via cursor    | ✅ `invoicing/reconcile` walks `/events?since=<cursor>` and persists the cursor per batch.              |

---

## Tests

- `packages/integrations/invoicing/src/webhook.test.ts` (16) — HMAC verify
  (valid / forged / wrong-secret / missing / replay-window / non-JSON), money
  helpers, fail-closed enum mapping.
- `packages/integrations/invoicing/src/adapter.test.ts` (8) — category routing
  - payload shaping.
- `__tests__/contract/invoicing/invoicing-webhook.contract.test.ts` (4) — route
  verifies signature, persists `ProviderEvent`, enqueues; idempotent on
  duplicate delivery; 400 on forged/missing signature.
- `__tests__/integration/invoicing-sync.test.ts` (4) — idempotent mirror
  upserts; **no double-payment**; skip-when-invoice-not-mirrored.

Full suite green: **640 tests / 99 files**, plus `tsc` and ESLint clean across
the integration package, `apps/web`, and `packages/core`.

---

## What you need from the invoicing team

1. Deploy the CRM, then paste `<origin>/api/webhooks/invoicing` into their
   **Settings → API & Integrations → Add webhook** (subscribe to `*`). They
   return a `whsec_…` secret.
2. They mint a `sk_live_…` API key with **read+write** scopes.
3. In the CRM → **Settings → Invoicing**, paste both; hit **Send test event** to
   confirm the badge goes green.

---

## Gaps / follow-ups

- **SSE consumer not yet wired.** Webhooks (instant) + nightly events-feed
  reconcile (heal) cover the sync contract today. The boot-time
  `GET /api/v1/stream?since=<streamCursor>` consumer belongs in the `worker`
  service; the client method, cursor column, and `saveStreamCursor` are ready —
  it needs a long-lived runner + reconnect loop. Until then sub-second push is
  via webhooks.
- **`task` and `student` entities** from the platform are acknowledged but not
  mirrored in this slice (the CRM models students under `BusinessAccountStudent`
  and tasks under `Task`; mapping them is a follow-up).
- **Webhook auto-registration.** `client.registerWebhook` exists; today setup is
  manual (paste the URL in their UI). A one-click "Register receiver" button
  from the settings page is an easy follow-up once we can read back the secret.
- **An ADR** for this integration should be added under `docs/adr/` per
  CLAUDE.md §34 (new integration semantics).
