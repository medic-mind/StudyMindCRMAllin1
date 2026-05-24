# ADR 0013: Discontinue safeguarding workflow for v1 sales CRM

- Status: Accepted
- Date: 2026-05-24
- Affects: CLAUDE.md §6.4, §10, §20, §20.1, §21.1, §41.3, §42 (safeguarding)

## Context

The StudyMind CRM was originally scoped with a full SEND safeguarding
workflow: DSL rota, concern intake, urgency-tiered notification fan-out
(Slack + PagerDuty + DPO email), encrypted concern bodies, triage actions,
LA referral capture, restricted-access enforcement on Contacts, UEBA on
safeguarding reads, and DSL SLA tracking. That work shipped as
`packages/core/safeguarding/concerns.ts`, the `/safeguarding` and
`/contacts/[id]/safeguarding` page surfaces, the `safeguarding` tRPC
router, the `safeguarding-sla` cross-cutting job, and the `dsl` role with
its own permission grants.

The team has reset v1 of the CRM to a sales-focused product: pipeline,
contacts, families, light finance reconciliation, and outbound comms via
Trengo / Gmail / Aircall. The SEND-safeguarding workflow is no longer in
scope. Carrying the implementation alongside the new pivot is a real cost:
DSL role gating on every contact read, a permanent restricted-access query
on every protected procedure, two AI prompt fragments that have to be
reasoned about whenever the style guide changes, and a substantial test
surface that reviewers must keep current.

## Decision

Drop the safeguarding **code** but keep the **schema**. Specifically:

- Delete the `/safeguarding` and `/contacts/[id]/safeguarding` page trees,
  the `safeguarding` tRPC router, the safeguarding triage UI, the
  `RestrictedAccessBanner` component, the `safeguarding-sla` Inngest
  function, `packages/core/safeguarding/concerns.ts` and its invariants,
  and the safeguarding entries in `packages/core/auth/policies.ts`,
  `packages/core/auth/rate-limits.ts`, and the AI prompt style fragments.
- Retain `SafeguardingFlag`, `EncryptedField`, and `DslRota` Prisma
  models as orphans (forward-only schema, CLAUDE.md §19). They have no
  consumers in the new build but stay in the schema so existing rows do
  not need a destructive migration.
- Retain `packages/core/safeguarding/encrypt.ts`, `decrypt.ts`, and
  `kms.ts`. These are general envelope-encryption primitives consumed by
  Gmail OAuth refresh-token storage (ADR 0012) and by any future field
  that needs crypto-shred on erasure. The folder name remains for path
  stability; the comments are updated to reflect the broader use case.
- Make `enforceRestrictedAccess` in `apps/web/lib/trpc/builders.ts` a
  no-op so that protected procedures continue to compile without changes
  while the gating logic is removed.
- The `dsl` role is mapped to `Manager` in the slice 2 role rename
  (ADR 0014). Until then, `dsl` retains its grants minus the safeguarding
  ones, which collapses to a Contact-read role.

## Consequences

- CLAUDE.md §6.4 (SafeguardingFlag state row), §10 (Aircall safeguarding
  detection paragraph), §21.1 (encryption "Safeguarding notes"),
  §41.3 (safeguarding invariants), and §42 (safeguarding workflow) are
  marked DEPRECATED and retained as historical context.
- KMS encrypt/decrypt code stays available for future use cases.
- The DSAR exporter no longer enumerates safeguarding rows but still
  walks any EncryptedField rows owned by the contact.
- A future product spike that revives safeguarding can rebuild the UI
  and workflow on top of the retained schema without a destructive
  migration.
