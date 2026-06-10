# ADR 0038 — GoCardless Direct Debit operating system

Date: 2026-06-10
Status: Accepted

## Context

The GoCardless integration was inbound-only and partial: webhooks for six
event types (payments confirmed/failed/late-failure, mandates
active/cancelled/replaced), a Family-keyed `GcMandate` + `Payment` mirror, and
an unused redirect-flow outbound. Staff still had to live in the GoCardless
dashboard to create plans, cancel them, collect one-off payments, or see a
customer's subscription history — and payments for mandates the CRM didn't
know about were dropped as "unresolved".

The business wants the CRM to be the single pane for Direct Debits: create
plans, cancel/pause/resume them, collect and retry payments, set up new
mandates, and see the complete history — every past subscription included —
with payments linked to the contacts they belong to.

## Decision

### 1. Complete provider mirror (new tables)

- **`GcCustomer`** — every customer at GoCardless. Carries the CRM link
  (`contactId`, `familyId`): the import auto-links **only** on a single
  unambiguous email match (never auto-merge, CLAUDE.md §3/§41.1); everything
  else waits for a human in the workspace. Linking a customer propagates the
  Family to its unlinked mandates, which is what lets the existing
  reconciliation pipeline pick them up.
- **`GcSubscription`** — every plan, all statuses (`GcSubscriptionState`
  enum, fail-closed `unknown`), including `finished`/`cancelled` history,
  plus next-charge info from `upcoming_payments`.
- **`GcPayment`** — every payment with its provider status
  (`GcPaymentState`). Deliberately wider than the reconciliation-facing
  `Payment` table, which keeps its existing role (family-linked, drives
  allocations/defaulters) — same two-table pattern as the invoicing mirror
  (ADR 0036).
- **`GcMandate`** widened into the complete mandate mirror: `familyId` is now
  nullable (mirror rows exist before a Family link), plus `gcCustomerId`,
  `reference`, `scheme`, `nextPossibleChargeDate`, `gcCreatedAt`. Provider-id
  links between mirror tables are soft (JS-joined) — no DB FKs onto provider
  ids, so webhook ordering can never violate a constraint.

### 2. Full outbound surface (`packages/integrations/gocardless/src/outbound.ts`)

`createSubscriptionPlan`, `cancel/pause/resumeSubscriptionPlan`,
`createOneOffPayment`, `cancelPendingPayment`, `retryFailedPayment`,
`cancelMandateAction`, and `completeHostedRedirectFlow`. Every mutation is
human-initiated, carries an Idempotency-Key derived from the request id on
creates, refreshes the mirror from the canonical response, writes an
AuditLogEntry, and appends a timeline Interaction when the customer is
linked. The hosted mandate flow now round-trips: setup links are minted per
click (flows expire ~30 min), and the public completion route
(`/api/gocardless/redirect-flow/complete`) completes the flow, mirrors the
new customer + mandate, and links them to the family/contact the agent chose.

### 3. Webhooks widened, mirror-first

`gocardless/event.received` now handles the full payment / mandate /
subscription lifecycle. The mirror updates for **every** handled event even
when no Family is linked (the old behaviour dropped these); the
reconciliation tables still require the Family link. Timeline Interactions
stay gated to the meaningful moments (payment confirmed/failed/late-failure,
mandate active/cancelled/replaced) so webhook echoes of CRM-initiated
subscription actions don't double-post.

### 4. Historic import

`backfill/gocardless.requested` (BackfillProvider enum gains `gocardless`)
walks customers → mandates → subscriptions → payments with keyset cursors,
one page per self-rescheduled invocation. Idempotent; one summary audit row;
CEO + Senior Manager trigger from the workspace.

### 5. Surface

tRPC `gocardless.*` (overview, customers.list/link, mandates
list/cancel/createSetupLink, subscriptions list/create/cancel/pause/resume,
payments list/create/cancel/retry, import start/status). Reads and money
mutations are CEO/Senior Manager/Manager (same set as `finance.refund`);
import is CEO/Senior Manager. UI: `/finance/direct-debit` becomes the
tabbed **Direct Debit workspace** (Plans · Payments · Customers & mandates ·
Issues), absorbing the existing defaulters table as the Issues tab.

## Alternatives considered

- **Make `Payment` the complete mirror** (nullable `familyId`): rejected —
  allocations, refunds and invariants (§41.2) assume a Family; a separate
  provider mirror keeps those guarantees intact.
- **DB foreign keys between mirror tables on provider ids**: rejected —
  webhook/event ordering would trip constraints; soft links + idempotent
  upserts converge instead.
- **GoCardless Billing Request Flows** for mandate setup: the older
  redirect-flow API is already half-built and sufficient; BRF can slot in
  later behind the same `createSetupLink` procedure.

## Consequences

- Late-failure semantics, defaulter scans, at-risk derivation and
  reconciliation are unchanged.
- Unlinked customers/payments are now stored and visible (workspace shows a
  "needs linking" queue) instead of silently skipped.
- `GcMandate.familyId` consumers must filter `familyId: { not: null }`
  (done in `dd-defaulters.ts`).

## Amendment (2026-06-10) — automated sign-up emails + durable setup links

The hosted-mandate flow gained a proper outbound system. A raw GoCardless
redirect flow expires after ~30 minutes, so it must never be emailed; instead:

- **`MandateSetupLink`** — a durable, unguessable token URL the CRM owns
  (14-day TTL). The public open route
  (`/api/gocardless/setup/[token]`) mints a fresh redirect flow at click time
  and 302s the parent to GoCardless; `MandateIntent.setupLinkId` ties each
  flow back so completion closes the link.
- **Automated emails** — issuing a link emails the parent a branded sign-up
  email automatically (`packages/core/src/email/direct-debit-setup.ts`,
  sent via the system Gmail mailbox, CLAUDE.md §14). One polite reminder goes
  out by itself 3 days later if the mandate is still not in place (one nudge,
  never a sequence); links auto-expire. Hourly boundary cron
  `gocardless/setup-link-maintenance`.
- **Surface** — tRPC `gocardless.setupLinks.{send,list,resend,revoke}`
  (replaces `mandates.createSetupLink`); the workspace Customers tab shows
  every outstanding link (emailed / reminded / opened / completed) with
  copy / re-send / revoke. Sends and reminders land on the contact timeline
  and in the audit log (`gocardless.setup_link.*`).
- The `/api/gocardless/setup` + `/api/gocardless/redirect-flow/complete`
  routes are on the middleware public-path allowlist (token-authenticated,
  not session) — the completion route was unreachable for parents before
  this amendment.

## Amendment (2026-06-10, second) — top-level nav section + master dashboard

Direct Debits outgrew its slot as a Finance child link. It is now its own
top-level **Direct Debits** section in the Operations nav group, and the
workspace gained a master dashboard:

- Routes move to real sub-paths (matching the Webinars/Boards convention so
  sidebar children highlight correctly): `/direct-debits` (Overview) ·
  `/direct-debits/{plans,payments,customers,issues}`. The legacy
  `/finance/direct-debit` route (and its `?tab=` deep links) permanently
  redirects — exactly one home, no duplication with the Finance section,
  which keeps reconciliation (discrepancies, refunds, payment links).
- **Overview** is the GoCardless master dashboard: monthly plan run rate
  (pure maths in `packages/core/src/finance/dd-insights.ts`, weekly/yearly
  normalised to monthly, fail-closed on unknown cadences), collected last
  30 days, money in flight, failed last 30 days, paused plans, customers to
  link, outstanding sign-up links, recent failures ("needs attention") and
  the next scheduled collections — all from one widened
  `gocardless.overview` query. Read-only: money actions stay behind the
  confirmed flows on the working tabs (CLAUDE.md §3).
