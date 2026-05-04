# ADR 0003: Interaction shape

- Status: Accepted
- Date: 2026-05-04

## Context

Every email, call, message, note, task, payment, booking, and AI insight needs to appear on a unified timeline view, scoped to a Contact or a Family. See CLAUDE.md §6.2. The timeline is the most-loaded view in the CRM and is the primary way agents answer "what is the true status of this family right now".

We need a representation that:

- Lets us load a chronological timeline cheaply, ordered by `occurredAt`.
- Carries different shapes per event type without losing typesafety.
- Survives schema changes per type without DB migrations every time.
- Makes cross-type queries (count of inbound interactions in 30 days, last touch, etc.) ergonomic.
- Plays well with Prisma and Postgres.

## Decision

A single polymorphic `Interaction` table with:

- A `type` enum column (`email_inbound`, `email_outbound`, `call_inbound`, `call_outbound`, `voicemail`, `sms_inbound`, `sms_outbound`, `whatsapp_inbound`, `whatsapp_outbound`, `note`, `task`, `payment`, `booking`, `ai_insight`, `family.state_changed`, `family.billing_contact_changed`, `safeguarding.concern_raised`, `safeguarding.la_referral`, `slack_summary`, `tender.state_changed`, plus a small set of others — see `packages/core/events/registry.ts`).
- A typed `payload` column of type `JSONB`, validated by a Zod schema per `type` defined in `packages/core/interaction/types.ts`.
- Foreign keys to `Contact` (nullable, for Family-only events like state changes) and `Family` (also nullable, for unconverted lead events).
- Standard CLAUDE.md §19 fields: `id` (cuid2), `occurredAt`, `createdAt`, `updatedAt`, `createdById`, `updatedById`, `deletedAt`.

Every read of `Interaction.payload` goes through `parseInteractionPayload(type, payload)` which dispatches to the right Zod schema. Direct field access on the raw JSON is forbidden by an ESLint rule.

## Consequences

- **Indexing strategy.** Two composite indexes back the timeline: `(contactId, occurredAt desc)` and `(familyId, occurredAt desc)`. A GIN index on `payload` is added if and when a query path needs to filter on payload fields; today only `type` and FK columns drive filters, so we hold off.
- **Validation is on us.** Postgres does not enforce the JSONB shape. The Zod schema in `packages/core` is the contract. Any read that bypasses `parseInteractionPayload` is a bug.
- **Schema migration becomes per-Zod-schema, not per-DB-column.** Adding a new event type means: register the type in `packages/core/events/registry.ts`, add the Zod schema in `packages/core/interaction/types.ts`, add a fixture, ship. No migration. Renaming or removing a field within a payload is a breaking change handled by the same versioning approach as our Stripe/GoCardless mirrors — fail closed on unknown shapes (CLAUDE.md §19, §45.4).
- **Cross-type queries are ergonomic.** "Last touch on this Family" is a single ordered scan, not a UNION across many tables.
- **Storage is JSONB.** Postgres TOAST handles large payloads. Big binary content (call recordings, email attachments) lives in S3 and is referenced by S3 key in `payload` (CLAUDE.md §10, §14).

## Alternatives considered

### Separate tables per event type

Rejected. The timeline view would need a UNION across 15+ tables, with per-type ordering by a synthetic `occurredAt` projection. Adding a new type would require a migration plus changes to every consumer of the timeline. We tried this in a prior project and it became the slowest page in the app within six months.

### Entity-Attribute-Value (EAV)

Rejected. EAV gives us the worst of both worlds: no typesafety, no schema, awkward queries, and Postgres-specific tooling we'd write ourselves. JSONB plus Zod gives us schema where it matters (the application layer) without paying the EAV tax.

### Event sourcing with a separate `Event` log

Rejected — overkill for the problem and a large operational burden. Event sourcing would add: a separate event store, projections, replay machinery, and snapshotting. We already have `ProviderEvent` for replay of external provider events (CLAUDE.md §7.1); adding a second internal event log on top would duplicate effort without solving a current problem. If we ever need full event-sourced reconstruction of state, we revisit. For now, `Interaction` is the timeline, and the database row is the truth.

### Polymorphic with a discriminated `payloadV1`, `payloadV2`, ... column set

Rejected. Adds columns we usually do not need. Schema versioning belongs inside the Zod schema, not the table.

## Follow-ups

- Section 45 (event taxonomy) is the registry; this ADR defers to it for the canonical `type` values.
- A property-based test in `packages/core/interaction/invariants.test.ts` confirms that every registered event type has a Zod schema and a fixture. CI fails on drift.
