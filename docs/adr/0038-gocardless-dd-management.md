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

## Amendment (2026-06-10, third) — GoCardless-dashboard parity pass

The workspace now mirrors the GoCardless dashboard's information
architecture (visuals stay on StudyMind design tokens, §4):

- **Customer record** at `/direct-debits/customers/[gcCustomerId]`
  (`gocardless.customers.detail`): identity + CRM-link controls, lifetime
  totals, bank mandates (with audited cancel), every plan, recent payments,
  and the customer's sign-up links. Customer names everywhere (lists,
  dashboard queues) click through to it; linked customers go to the CRM
  contact.
- **List parity**: per-status counts on the Plans/Payments filter strips
  (`statusCounts`), customer search on both lists (resolved through the
  customer mirror), and a `?customer=` deep-link filter set by the record's
  action buttons — which also prefills the New-plan / Collect-payment
  mandate pickers so "create for this customer" is one click.

## Amendment (2026-06-11, fourth) — payouts + activity feed

The last two GoCardless dashboard areas land in the workspace:

- **Payouts**: `GcPayout` mirror (status as normalised text, §15) plus
  `GcPayment.gcPayoutId` (links.payout, only ever set forward). Webhook
  `payouts/paid` and a `payouts` backfill phase keep it complete. UI: a
  Payouts tab (status chips, fees, settled-payment counts) and a per-payout
  drill-down listing the customer payments inside the transfer.
- **Activity feed**: `gocardless.events.list` reads the `ProviderEvent`
  replay log (no new storage), parses each event's links, and resolves them
  to customers through the mirror — the CRM's Events screen. Filterable by
  resource, keyset "load older" pagination.

## Amendment (2026-06-11, fifth) — proper list system on every table

The workspace lists graduated from single-page feeds to real tables, all
URL-driven via the shared list-controls primitives (CLAUDE.md §26):

- Offset paging with true totals ("Showing 1–50 of 1,234"), page-size
  select, and whitelisted column sorting (nullable columns sort nulls
  last) on plans, payments, customers, mandates and payouts.
- Filters: status/state chips with live counts that respect the other
  filters (shared where-builders keep chips and rows in agreement),
  customer search on every list, charge/arrival date ranges, £ amount
  ranges, plan cadence; payments/payouts also show the filtered-set value.
- A flat **Mandates** sub-view on the Customers tab (state chips + counts,
  search via mandate id/reference or the customer mirror, audited cancel).
- CSV export per list honouring the current filters + sort (5000-row cap,
  the §37 convention).
- Cursor pagination on these mirrors was replaced by offset paging — an
  operator table needs arbitrary sorts and jumpable pages; the keyset
  cursor convention remains for timeline-shaped feeds (the Activity tab).

## Amendment (2026-06-13, sixth) — plan total + cancelled-part-way shortfalls

The defaulter engine (`dd-defaulters.ts`) is invoice- and failed-payment-
driven, so a family that quietly cancelled a fixed-length plan part-way —
without ever bouncing a Direct Debit or leaving an unpaid invoice — was
invisible. Two changes close that gap:

- **`GcSubscription.totalPaymentCount`** mirrors GoCardless `count` (total
  instalments for a fixed-length plan; null when open-ended). It lets us
  compute a plan's contracted value (`count × amountMinor`). Synced in
  `subscriptionMirrorInput` and persisted via `upsertGcSubscriptionMirror`;
  surfaced on the contact's Direct Debit panel as the plan term + total.
- **`dd-plan-shortfall.ts`** (pure + tested) reconciles every ended plan
  (`cancelled`/`finished`) against its contracted total and reports the
  amount still due, the instalments collected vs contracted, and whether the
  plan was cancelled part-way. Open-ended plans have no contracted total and
  are excluded (fail closed, §8). Surfaced read-only as a second section of
  the Issues tab and at `finance.directDebit.listPlanShortfalls` (audited).
  It never charges or duns — humans act (§3).

Contact linking also gained a backfill: **`linkUnlinkedGcCustomers`** re-runs
the unambiguous email auto-link for customers imported before their CRM
contact existed (still unambiguous-only — never auto-merge, §3/§41.1),
propagating the Family to orphaned mandates so their plans/payments reach the
contact panel. It runs as the final step of the GoCardless backfill.

A follow-up in the same area adds **active-plan arrears**: `dd-plan-shortfall.ts`
also estimates, from a plan's cadence + start date, how many instalments an
*active* plan should have collected by now and flags any that are at least two
behind (`finance.directDebit.listActivePlanArrears`, audited; a third Issues
section). This is a conservative proxy — GoCardless owns the real charge
calendar — so it only surfaces a plan for a human to check, never charges.

These plan-level signals are also raised **proactively** by the nightly
`finance/flag-dd-defaulters` job (`flagPlanIssues`): for any plan whose
GoCardless customer is linked to a Family it upserts a
`direct_debit_plan_shortfall` or `direct_debit_plan_arrears`
ReconciliationDiscrepancy (idempotent on `(familyId, category, contextHash)`)
and the worker boundary posts a combined `#crm-finops` summary — so finance is
told, not just shown. The Direct Debits **Overview** carries matching headline
tiles (count + total due, linking to Issues), and both Issues tables support
column sorting + filter-honouring CSV export.

### Follow-up (2026-06-13) — phone linking, self-healing, actionable issues

- **Phone as a second link key.** `GcCustomer.phone` mirrors GoCardless
  `phone_number`. `findContactForGcCustomer` tries the unambiguous email match
  first, then an unambiguous E.164 phone match (`findContactForGcPhone`), used
  by both the import auto-match and the `linkUnlinkedGcCustomers` backfill — so
  a DD customer with no/non-matching email still reaches its CRM contact. Still
  unambiguous-only; a shared landline (>1 match) never auto-links (§3/§41.1).
- **Self-healing discrepancies.** `flagPlanIssues` resolves any open
  `direct_debit_plan_shortfall`/`direct_debit_plan_arrears` discrepancy whose
  plan no longer appears in the current issue set (e.g. an arrears plan caught
  up), so the Issues queue reflects reality without manual cleanup (golden
  rule #4).
- **Actionable Issues rows.** Both plan-issue tables carry a "Chase" action
  (opens a follow-up Task against the linked contact/family) for linked plans.

### Follow-up (2026-06-13, second) — robust linking, full self-heal, panel badges

- **Format-insensitive phone linking.** `findContactForGcPhone` now matches on
  the last-9-digit `phoneKey` (`endsWith`) — the same key the lead funnel and
  missed-calls workspace use — so "+447700900123", "07700900123" and
  "447700900123" converge. Still unambiguous-only (§41.1).
- **Recurring relink cron.** `gocardless/relink-customers` (every 6h) runs
  `linkUnlinkedGcCustomers` so a contact created *after* its DD customer was
  imported gets linked automatically, not only at import time. Audited
  (`gocardless.customers.relinked`) only when it links something.
- **Defaulter self-heal.** `flagDefaulters` now resolves open
  `direct_debit_default` discrepancies for families no longer in the defaulter
  set, matching the plan-issue self-heal (golden rule #4).
- **Contact-panel shortfall badge.** `gocardless.contactSummary` computes the
  per-plan shortfall for the contact's ended fixed-length plans (reusing
  `classifyPlanShortfall`), and `ContactDirectDebitPanel` renders a
  "£X still due" badge on a plan cancelled/finished early.

## Amendment (2026-06-14, seventh) — prospective tracking + recovery cases

Two changes turn the cancelled/underpaid surface into a working recovery system.

**Prospective only.** `GcSubscription.shortfallIgnored` excludes plans that were
already cancelled/finished at go-live (June 2026) — handled on another system —
so the CRM only tracks cancellations from go-live onward. The go-live migration
snapshots the existing terminal set as ignored; `upsertGcSubscriptionMirror`
sets the flag at create-time for any plan first seen already terminal (a
historic import), while a plan first seen active that later cancels stays
tracked. `listPlanShortfalls` filters `shortfallIgnored = false`; the job's
resolve-on-recovery then clears stale discrepancies for the removed plans. No
separate "ignored" view (avoids duplication).

**Recovery cases.** `DirectDebitCase` (one per plan, soft-linked like the GC
mirror) is the agent workflow over a shortfall: `DirectDebitCaseStatus`
(`new → chasing → escalated → recovered | written_off`, reopenable), an owner,
notes, and a recovery record (Phase 2 links the actual invoicing/Stripe
payment). Pure transition table in `packages/core/src/finance/dd-cases.ts`
(`canTransition`, unit-tested); tRPC `finance.directDebit.cases.*`
(forSubscriptions / setStatus / assign / setNotes / assignableUsers, finance
role, audited `direct_debit.case_*`). The case is created lazily on first
action. Surfaced as a Case column on the Issues tab and reflected as a status
badge on the contact + family Direct Debit panels. All outbound recovery comms
(reminders, legal escalation, Trengo) are human-confirmed drafts — Phase 3.

**Phase 2 — reconciliation recording.** `recordRecovery` (core, tested) closes a case as `recovered` with the amount, method (`bank_transfer` via the invoicing site / `stripe` / `direct_debit` / `manual` / `other`) and an optional reference (invoice id, Stripe payment id). tRPC `finance.directDebit.cases.recordRecovery` (finance role, audited `direct_debit.case_recovered`); UI `RecordRecoveryDialog` on the Issues case cell. Records that money arrived elsewhere — never charges (§3). Auto-clear from invoicing/Stripe webhooks is a follow-up.

**Phase 3a — recovery-comms templates.** `DdRecoveryTemplate` (kind: reminder / legal_escalation / other; channel: email / trengo / sms; subject + `{{token}}` body) is the staff-authored copy used to draft a human-confirmed send from a case. We ship NO copy — bodies start empty; Managers write them (legal wording is theirs). Pure token renderer `renderRecoveryTemplate` (`packages/core/src/finance/dd-comms.ts`, tested). tRPC `ddRecoveryTemplate.*` (list/pickList finance read; create/update/archive/restore Manager+; audited `dd_recovery_template.*`). UI: Settings → Direct Debit recovery templates. Phase 3b wires the dedicated human-confirmed send from a case (drafts from a template, agent reviews + sends, logs to the customer page).
