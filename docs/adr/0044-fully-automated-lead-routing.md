# ADR 0044 — Fully automated lead routing (no triage tray)

Date: 2026-07-18
Status: Accepted

## Context

ADR 0023's router was conservative: a submission with no email/phone, or an
email/phone shared by several contacts, parked in a "Leads triage" tray for a
human. In practice the tray was a dead end — it offered no resolution action
beyond re-running the same automation or dismissing — and the operator's
direction (2026-07) is explicit: lead handling must be fully automatic, with
no manual verification step.

## Decision

`planLeadRouting` / `chooseContactMatch` (packages/core/src/lead/match.ts) no
longer produce `needs_triage`:

- **Shared email/phone (2+ contacts)** → the enquiry attaches to the most
  recently active matching contact (candidates are queried
  `updatedAt desc`; the head of the list is the pick). The pick is stamped
  `ambiguousResolved` on the timeline Interaction and the audit row, so a
  wrong pick is visible and correctable. This annotates a contact — records
  are never merged (§41.1 stands).
- **Name-only submissions (no email, no phone)** → onboard a fresh contact,
  or attach when exactly ONE existing contact has that exact name. Two
  same-named contacts never auto-attach — a duplicate contact is reversible;
  a stranger's enquiry on the wrong timeline is not.
- **Nothing at all to key on (no name, email or phone)** → auto-dismissed as
  junk (`status: dismissed`, audited `lead.dismissed` with `auto: true`).
  There is nobody to contact, so a tray row would only rot.

A new cron `lead/reprocess-unresolved` (every 30 min, batch 200) re-runs the
classifier over `needs_triage` legacy rows and `received` rows whose classify
event was lost — draining the historic backlog through the new rules and
self-healing ingest hiccups. `needs_triage` remains in the status enum for
those legacy rows only; nothing writes it any more.

The `/leads` page is reframed as a **Web enquiries log** (default view: All
activity; outcome vocabulary in plain English), with a "Needs attention" view
that appears only while legacy rows remain.

## Consequences

- Zero manual lead work: every submission ends as a new customer, an
  annotation on an existing customer, or an audited junk dismissal.
- The ambiguous-pick trade-off is deliberate and operator-chosen: a rare
  wrong attach (flagged `ambiguousResolved`) is preferred over a queue.
  §3's "no silent mutation" is honoured by stamping + auditing every pick.
- Also in this change: `card.clearBoard` (Manager+) bulk-archives every live
  card on a board in one confirmed, audited action (`board.cleared`) — the
  board-scale twin of the stage-archive precedent.
