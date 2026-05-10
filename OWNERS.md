# Owners

Single source of truth for who to ping. Referenced by CLAUDE.md §40.
Update in the same PR as a role change.

> Names below are placeholders. Each `<TBD — fill before deploy>` must be
> replaced with a real person before the CRM goes to production. The
> review checklist for the launch ADR explicitly checks this file.

## Product

- **Product owner:** `<TBD — fill before deploy>`
- **Tech lead:** `<TBD — fill before deploy>`
- **Initial super_admin (seeded):** Aashir (`aashir@studymind.co.uk`) — bootstrapped via `pnpm seed:super-admin`. See `docs/runbooks/seed-super-admin.md`.

## Compliance

- **Designated Safeguarding Lead (DSL):** `<TBD — fill before deploy>`
- **Deputy DSL:** `<TBD — fill before deploy>`
- **Data Protection Officer (DPO):** `<TBD — fill before deploy>`

## On call

- **Primary rotation owner:** `<TBD — fill before deploy>`
- **Secondary rotation owner:** `<TBD — fill before deploy>`
- **Incident commander backup:** `<TBD — fill before deploy>`
- **Comms lead (external messaging during incidents, CLAUDE.md §25.3):** `<TBD — fill before deploy>`

## External relationships

- **Stripe account owner:** `<TBD — fill before deploy>`
- **GoCardless account owner:** `<TBD — fill before deploy>`
- **AWS account owner:** `<TBD — fill before deploy>`
- ~~**Clerk workspace owner:**~~ Auth is now self-hosted (ADR 0010). The role no longer applies.
- **Railway project owner:** `<TBD — fill before deploy>`

## Escalation

For escalation on safeguarding or GDPR questions, ask the DSL and DPO
directly. Do not guess.

For Sev 1 incidents follow `docs/runbooks/disaster-recovery.md` —
incident commander assignment is automatic via PagerDuty.
