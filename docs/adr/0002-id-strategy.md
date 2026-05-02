# ADR 0002: ID strategy — cuid2 everywhere

Status: accepted
Date: 2026-05-02

## Context

CLAUDE.md §19 mandates: "All IDs are cuid2. No incrementing integers in user-facing URLs." Slice 1 shipped with `crypto.randomUUID()` placeholders so we did not have to add a dependency before the ADR landed. We need to standardise on cuid2 before the surface area grows.

## Decision

We adopt `@paralleldrive/cuid2` as the single ID generator across the codebase. Every application-level `newId()` helper, audit row id, request id, and tRPC trace id calls `createId()` from that package. Prisma `@id` columns stay as `String` and are populated by application code, not by Prisma's `@default(cuid())` (which is cuid v1 — not cuid2 — see the unresolved Prisma issue tracking native cuid2 support).

We do **not** use Prisma's built-in `cuid()` default. Cuid v1 has known collision and entropy concerns we do not want to inherit. We pay the small cost of supplying ids in application code in exchange for one consistent generator across server, worker, and tests.

## Alternatives considered

- **UUID v4 via `crypto.randomUUID()`.** Already in the standard library, zero dependency. Rejected: CLAUDE.md is explicit about cuid2 for length, sortability-ish properties, and URL ergonomics; aligning with the doc beats avoiding one tiny dep.
- **Prisma `@default(cuid())`.** Rejected: that's cuid v1, not cuid2.
- **Postgres-side generation via `dbgenerated`.** Rejected: no native cuid2 in Postgres without a custom function, and we want the generator co-located with the writer for testability and determinism in seed/factories.

## Consequences

- One workspace dep: `@paralleldrive/cuid2`.
- Every Prisma `create` supplies an `id` value. Existing code already does this; the swap is one-for-one.
- Tests using factories can inject deterministic ids by accepting an `idFn` parameter; default is `createId`.
- IDs are 24 chars, lower-case alphanumeric. URL-safe by construction.
- Migration: no schema change required. Existing rows keep their UUID-shaped ids; new rows get cuid2. The `id` columns are opaque `text` either way.
