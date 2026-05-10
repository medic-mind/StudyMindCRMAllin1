# ADR 0010: Self-hosted authentication (Auth.js v5 + Postgres)

- Status: Accepted
- Date: 2026-05-10
- Supersedes: the Clerk decision recorded in CLAUDE.md §3 prior to this date.

## Context

Slices 1–14 built on Clerk for sign-in, MFA, and session management. Clerk
gave us a fast start but we have since concluded that the StudyMind CRM should
operate entirely on Railway-hosted infrastructure for three reasons:

1. **Data residency and audit.** We process minors' data and EHCP extracts.
   Every additional processor expands our DPIA surface. Keeping
   identity entirely inside our Postgres reduces what we have to document and
   what an LA contract reviewer has to audit.
2. **Vendor risk.** Clerk pricing, terms, and SLAs are out of our control. A
   pricing change, an outage, or a deprecation forces an emergency migration
   we are not prepared for.
3. **Operational fit.** The CRM is a staff-only tool with at most a few dozen
   users. We do not need consumer-grade SSO, social login, or organisation
   trees. We need email + password, MFA, password reset, lockout, and a
   strong audit trail.

## Decision

Replace Clerk with self-hosted Auth.js v5 (`next-auth@5.x`) backed by our
Railway Postgres via `@auth/prisma-adapter`. Specifics:

- **Credentials provider only.** Email + bcrypt-hashed password. No social
  providers in v1.
- **Session storage.** JWT cookie strategy with a server-side `Session` table
  for active-session listing and "sign out other sessions" support. The cookie
  is HTTP-only, `Secure`, `SameSite=Lax`.
- **Email verification and password reset.** First-party flows backed by
  single-use, time-bound tokens (sha256-hashed at rest in Postgres) and
  delivered via Resend (already wired in Slice 13).
- **Optional TOTP MFA.** Per-user, KMS-encrypted secret stored as an
  `EncryptedField`. Recovery codes follow in a later slice; WebAuthn is out
  of scope for v1.
- **Lockout.** 5 failed attempts within 15 minutes locks the account for 15
  minutes. Counters live on the `User` row.
- **Audit.** Every sign-in, sign-out, password change, role change, MFA
  enrolment, and lockout writes an `AuditLogEntry` (CLAUDE.md §20).
- **Super-admin bootstrap.** Aashir is seeded as the first `super_admin`
  (ADR 0009 introduces the role). Either his password is set from the
  `INITIAL_SUPER_ADMIN_PASSWORD` env at seed time with `mustResetPassword=true`,
  or a 7-day email-verification token is printed to stdout for the operator
  to deliver out-of-band.

## Consequences

We now own:

- **Password security.** bcrypt cost factor 12 today, reviewed quarterly. We
  publish a runbook for breached-credential response.
- **MFA delivery.** TOTP only; SMS is explicitly rejected.
- **Reset and verification UX.** No enumeration: every `forgot` request
  returns an identical response regardless of whether the email exists.
- **Session management.** Listing active sessions, "sign out other sessions",
  and force-reset on next login are all our code.
- **Breach response.** Without Clerk's anomaly detection we add basic UEBA on
  `AuditLogEntry` (already scoped in CLAUDE.md §44.3) covering sign-in
  spikes, off-hours admin reads, and impossible-travel signals.

Trade-offs we accepted:

- More code to maintain. Mitigated by Auth.js v5's small, well-trodden
  surface and a focused integration test suite.
- No social login. Acceptable: staff sign in with their work email.
- We must rotate `AUTH_SECRET` on a schedule and have a documented procedure
  for compromise. Added to `docs/runbooks/secret-rotation.md`.

## Migration

Clerk users are out of scope for migration. The team is small; everyone
re-registers via email invite from a `super_admin`. Aashir is seeded directly
by `prisma/seed.ts`. Existing Slice 14 `User` rows are kept; the migration
adds `passwordHash`, `emailVerifiedAt`, and lockout columns.

## Alternatives considered

- **Lucia.** Smaller surface but lower momentum; we chose Auth.js v5 for the
  larger ecosystem and Prisma adapter maturity.
- **Hand-rolled.** Rejected. Authentication is the wrong place to write
  custom crypto, even with bcrypt available.
- **Keycloak / Authentik self-hosted.** Heavier deploy footprint than the
  CRM itself. Overkill for staff-only.
