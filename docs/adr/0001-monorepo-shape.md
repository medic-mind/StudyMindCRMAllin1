# ADR 0001: Monorepo shape

- Status: Accepted
- Date: 2026-05-02

## Context

The StudyMind CRM has one deployable web service plus a worker, but a number of
distinct concerns: domain logic, integrations with eight external providers,
shared UI tokens, and AI tooling. We want module boundaries that are enforceable
at build time and that make ownership obvious.

## Decision

A pnpm + Turborepo monorepo with the following top-level shape:

- `apps/web` — the only deployable Next.js app (web + API routes).
- `packages/db` — Prisma schema and client singleton.
- `packages/core` — pure domain logic. No I/O. Cannot import integrations.
- `packages/integrations/<svc>` — one folder per external service. Cannot
  import from `apps/web`.
- `packages/audit`, `packages/ai`, `packages/jobs`, `packages/ui` — cross-cutting.

Module boundaries are enforced by ESLint `no-restricted-imports` rules in
`eslint.config.mjs`.

## Consequences

- Adding a new integration is a copy-paste from an existing one.
- Refactors that cross boundaries are obvious in code review.
- Domain logic stays testable without mocking I/O.
