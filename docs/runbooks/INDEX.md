# Runbook index

Operational playbooks for StudyMind CRM. Every PagerDuty alert links to one of these. Add a new file when a new alert ships; update this index in the same PR.

## Written

- [aircall-webhook-disabled.md](aircall-webhook-disabled.md) — Aircall has disabled our webhook after 10 consecutive failures. Confirm, re-enable via the Public API, backfill the gap from REST.
- [billing-contact-change.md](billing-contact-change.md) — Switching the billing contact on a Family. Manual Stripe and GoCardless re-issue, never automatic.
- [safeguarding-la-referral.md](safeguarding-la-referral.md) — Recording a referral to LA children's services or MASH. DSL only, encrypted body, retention override.
- [secret-rotation.md](secret-rotation.md) — Cadence and procedure for every secret. What to do if one leaks.
- [disaster-recovery.md](disaster-recovery.md) — The script for CLAUDE.md §46. RPO/RTO, the 9-step playbook, incident channel checklist.
- [seed-super-admin.md](seed-super-admin.md) — Bootstrap the initial `super_admin` user (Aashir by default). Password path vs link path, idempotency, last-super_admin guard.
- [on-call.md](on-call.md) — Rotation, start-of-shift checks, dashboards to watch, and the page-response sequence (CLAUDE.md §33, §40).

## Referenced by CLAUDE.md but not yet written

These are stubs to surface what is missing. Pick one off the list when you have the operational context to write it well.

- `aircall-recordings-retention.md` — When a parent contract requires retention beyond Aircall's window (CLAUDE.md §10).
- `gocardless-late-failure.md` — Reversing a confirmed payment after `late_failure_settled` (CLAUDE.md §9).
- `gocardless-mandate-replaced.md` — Walking the `replacedById` chain (CLAUDE.md §9).
- `stripe-dunning-escalation.md` — Family `at_risk` derivation and ops handoff (CLAUDE.md §8, §6.4).
- `gmail-watch-renewal-failure.md` — When `gmail/refresh-watch` cannot renew a mailbox (CLAUDE.md §14, §17.1).
- `inngest-dead-letter-triage.md` — Working the dead-letter queue (CLAUDE.md §17.2).
- `reconciliation-discrepancy-triage.md` — Finance weekly review of the discrepancy backlog (CLAUDE.md §6.3, §33).
- `safeguarding-restricted-access.md` — Moving a flag to `restricted_access` and the comms lockdown that follows (CLAUDE.md §42.3).
- `dsar-export.md` — Producing a DSAR zip (CLAUDE.md §21).
- `booking-pull-failure.md` — Polling failure modes for the booking site sync (ADR 0007).
- `vendor-incident-response.md` — Third-party breach affecting our integrations (CLAUDE.md §44).

When you write one, move it into "Written" above with a one-line summary.
