# Runbook: On-call

CLAUDE.md §33 (engineering rituals) and §40 (escalation).

## Rotation

One primary, one secondary. Week-long rotation, **handover at Friday
16:00 UK time**. Primary owns Sev 1 and Sev 2 incidents; secondary
covers if the primary is unavailable.

Names: see `OWNERS.md`.

## Start of shift checks

Run these at 09:00 on Monday and after any unplanned outage:

1. **PagerDuty.** No open Sev 1/2 incidents assigned to you. Escalation
   policy points at the right backup.
2. **Sentry.** Skim issues from the last 24 h on the production project.
   Triage anything new; ack anything in flight from the previous rotation.
3. **Axiom.** Check the `crm-prod` log volume for spikes outside normal
   business hours.
4. **Inngest.** Dead-letter queue is empty (or every entry has an owner
   in Asana).
5. **Stripe / GoCardless dashboards.** No backlog of failed events on
   our endpoints. Webhook delivery rate above 99 %.
6. **Aircall webhook.** Not in the disabled state (CLAUDE.md §10).
7. **Reconciliation.** Last night's `finance/reconcile-all-families` job
   ran and completed before 06:00 UTC.
8. **Cost.** Today's OpenAI burn is on track. Check `#crm-finops`.

## Dashboards to keep open

- Sentry — `crm-prod` project.
- Axiom — `crm-prod` workspace, with the saved query "all errors last 1h".
- Inngest — function dashboard for `crm-prod`.
- Railway — the project page (CPU, memory, deploy status).
- PagerDuty — incidents view.

## When you are paged

1. **Acknowledge** in PagerDuty within the SLO (Sev 1: 5 min, Sev 2: 15
   min). CLAUDE.md §25.2.
2. **Stabilise first.** Rollback, feature flag, or shed traffic before
   investigating root cause. CLAUDE.md §25.3.
3. **Communicate** in `#crm-incidents` every 30 minutes until resolved.
4. **Resolve** by metric, not by feeling.
5. **Postmortem** within 5 working days for Sev 1/2. Blameless. Track
   action items in Asana.

## Common runbooks

- Aircall webhook disabled: `aircall-webhook-disabled.md`.
- Billing contact change: `billing-contact-change.md`.
- DSAR export: `dsar-export.md`.
- Disaster recovery: `disaster-recovery.md`.
- Lighthouse CI: `lighthouse-ci.md`.
- Safeguarding LA referral: `safeguarding-la-referral.md`.
- Secret rotation: `secret-rotation.md`.
- Seed super-admin: `seed-super-admin.md`.

## Handover

The outgoing primary writes a short handover note in `#crm-eng` Friday
afternoon covering: open incidents, ongoing investigations, anything
flaky to watch, anything you deferred. The incoming primary acks before
16:00.
