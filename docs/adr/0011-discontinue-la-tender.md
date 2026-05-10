# ADR 0011: Discontinue Local Authority tender + AP placement workflow for v1

- Status: Accepted
- Date: 2026-05-10
- Affects: CLAUDE.md §43 (LA tender + AP workflow)

## Context

Slices 8–11 built a Local Authority tender pipeline, `LAContract` entity,
LA invoicing flow, AP placement deadline tracking, kanban UI, and AI
prompts in `packages/ai/prompts/tender/` and `packages/ai/prompts/lacontract/`.
This was scoped against an early v1 ambition that included statutory LA
commissioning end-to-end.

The team has since reset v1 scope to PAYG family billing + reconciliation,
safeguarding, and operational comms. LA tender work continues to happen
outside the CRM in spreadsheets and email until we are ready to revisit it
with a focused product spike.

Carrying the existing implementation has costs:

- Maintenance burden across `packages/core/tender`, `packages/core/lacontract`,
  `packages/jobs/lacontract`, two router files, two AI prompt sets, two UI
  surfaces, and an Inngest deadline-watcher boundary.
- Reconciliation engine branches on `billingParty = local_authority`, adding
  paths that have never been exercised in production.
- Tests, fixtures, and documentation that reviewers must keep current.

## Decision

Remove the LA tender + AP code from the v1 surface:

- Delete `packages/core/src/tender`, `packages/core/src/lacontract`,
  `packages/jobs/src/lacontract`, `packages/ai/src/prompts/tender`,
  `packages/ai/src/prompts/lacontract`.
- Delete `apps/web/app/(app)/pipeline/tenders` and
  `apps/web/app/(app)/finance/la-contracts`.
- Deregister the `tender` and `lacontract` tRPC routers and the
  `lacontract-deadline-watcher` Inngest function.
- Revert reconciliation to the pre-Slice-8 `reconcileFamily` path that
  treats every Family identically.
- Strip `tender.*`, `lacontract.*`, `ap_placement.*`, and
  `tutor.session_note` events from `packages/core/src/events/registry.ts`.

The underlying database tables (`Tender`, `LAContract`, `LAInvoice`,
`APPlacement`, etc.) are **retained** as orphaned schema for forward
compatibility per CLAUDE.md §19 (forward-only migrations). A follow-up
migration may drop them once we have decided whether the v2 LA workflow
will reuse the same shape.

`Family.billingParty` enum keeps the `local_authority` value at the database
level but is no longer referenced from application code paths.

## Consequences

- The reconciliation engine is simpler and faster.
- The LA tender feature must be rebuilt from scratch when we revisit it.
  ADR 0011 (this document) and the deleted code's git history are the
  starting reference.
- Reviewers no longer need to understand statutory LA semantics to merge
  finance changes.
- Tests for removed modules are deleted in the same PR; no flaky leftover
  suites.
