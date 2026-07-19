# ADR 0045 — Automated Direct Debit chasing (per-person dunning)

Date: 2026-07-19
Status: Accepted

## Context

ADR 0038's recovery cases gave finance a per-plan workflow (status, owner,
human-confirmed sends) but everything outbound was manual. The operator's
direction (2026-07): a cancelled Direct Debit with money outstanding should
be chased AUTOMATICALLY — escalating emails/texts carrying the person's
individual re-signup link — with per-person control over channels, a manual
"up to date" tick that stops everything, and automatic detection when the
person signs back up. This is a deliberate, operator-chosen widening of the
"no auto-send" default (§3): the templates are staff-authored, the link is
staff-pasted, and every send is logged + audited.

## Decision

`DirectDebitCase` grows chase state: `gcSubscriptionId` becomes nullable
(manual person-level cases), per-case `sendEmails`/`sendTexts` flags,
editable `chaseEmail`/`chasePhoneE164`, the staff-pasted `setupLinkUrl`
(GoCardless or Stripe), `cadenceDays` (default 3), `autoChase` master
switch, and the escalation cursor (`escalationStep`, `lastAutoMessageAt`,
`nextAutoMessageAt`). Every send lands in the new `DdCaseMessage` history
table plus a contact-timeline note and a `direct_debit.case_message_sent`
audit row.

The hourly `finance/dd-chase-tick` engine, per armed case:

1. **Auto-resolve** — an ACTIVE mandate in the GC mirror created after the
   case opened (provider `gcCreatedAt`, so a backfill can't spoof it) closes
   the case as recovered and stops all messages. Stripe re-signups can't be
   seen from the mirror — those are ticked off manually.
2. **Send what's due** — walking the `DdRecoveryTemplate` sequence per
   channel in `sortOrder` (staff-authored copy, each step more serious;
   we still ship none). Email via the system Gmail; SMS via Trengo under the
   case owner's agent token (§11 — per-agent tokens, no shared token).
   Failures are recorded on the message row and retried next day, never
   escalated past.
3. **Exhaustion** — when every enabled sequence has been fully sent, the
   engine stops (autoChase off, status `escalated`, audited) and the case
   waits for a human call rather than repeating the final notice forever.

Nothing ever sends without the staff-pasted link — auto-opened and manual
cases sit in the "Needs link" view until someone provides it.

UI: a **Chasing** tab in the Direct Debits workspace
(`/direct-debits/chasing`): add a customer manually (contact search +
outstanding £ + link + channel flags), per-row link editing, channel
toggles, pause/resume, "Up to date ✓", and the expandable per-person
message history. Template copy is managed at Settings → DD recovery
templates. Reads all staff; writes Manager+ (`finance.directDebit.cases.
{chaseList,openManualChase,updateChase,markUpToDate,chaseMessages}`).

## Consequences

- Dunning becomes zero-touch after the link is pasted, and stops itself on
  a real re-signup — the two failure modes (nagging someone who paid,
  forgetting someone who didn't) are both closed.
- The auto-send widening is bounded: staff copy, staff link, per-person
  opt-outs, full logs, exhaustion stop. §41.1 (never merge) and §3's
  no-auto-charge stand untouched — this only ever sends messages.
