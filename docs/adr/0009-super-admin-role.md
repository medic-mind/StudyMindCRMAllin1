# ADR 0009: Super-admin role above admin

- Status: Accepted
- Date: 2026-05-09

## Context

The CRM RBAC model in CLAUDE.md §20 has six roles, with `admin` as the ceiling.
Today an `admin` can grant any role, including another `admin`, and can rotate
secrets stored in the platform. As the team grew during Slices 11–13 we
accumulated five `admin` accounts — every senior on-call needs admin to do
their job, but they should not all be self-promoting or be able to grant
`admin` to a peer without explicit ratification.

Two specific gaps:

1. **Self-elevation.** An attacker who phishes one `admin` can mint another
   `admin` immediately — the role is its own gate. There is no separation of
   duties on the most powerful capability.
2. **Org-wide controls.** Secret rotation, tenant config (e.g. the Slack
   channel allowlist in §12), and "irrevocable" actions like revoking another
   admin should sit above the daily admin's bar.

We want exactly one or two people with the ability to grant `admin` and to
perform org-wide write operations. The bar to obtain that role should be
"physical signoff from the founders," not a self-service tRPC call.

## Decision

Add a new role `super_admin` strictly above `admin`. `super_admin` inherits
every action `admin` has plus four exclusive actions:

- `user.role.grant_super_admin`
- `user.role.grant_admin`
- `user.role.revoke_admin`
- `secrets.rotate`
- `tenant.config.write`

A new pure function `canGrantRole(actorRole, targetRole)` is the single source
of truth for grant policy. `super_admin` can grant any role; `admin` can grant
any role **except** `admin` and `super_admin`; everyone else returns `false`.
The function is called from both `assignRole` and `revokeRole`. The UI hides
buttons it cannot use, but the server validates.

A guard on `revokeRole({ role: 'super_admin' })` refuses to remove the last
active `super_admin` — `BusinessError('LAST_SUPER_ADMIN')`. We prefer a hard
refusal over a soft warning because the recovery path (re-seeding via the
runbook in §8) is the only safe restore.

## Alternatives considered

- **Keep `admin` as the ceiling and rely on a Clerk org-owner flag.** Rejected:
  couples our application authorization to Clerk's org primitive, which we
  intentionally do not use today (one tenant, no Clerk Organizations). It
  would also mean two sources of truth — Clerk and our `RoleAssignment`
  table — for the most sensitive permission.
- **Separate "owner" group in Clerk metadata.** Rejected: same dual-source
  problem and harder to test. Our policy belongs in `packages/core/auth/`.
- **Quorum-style two-admin approval for grants.** Rejected for now — adds
  complexity we do not need at five admins. Revisit if the team grows past
  twenty.

## Consequences

- CLAUDE.md §20 role list extends to seven roles. The permission matrix gains
  a `super_admin` column. The matrix in the doc is regenerated from
  `packages/core/src/auth/policies.ts` per CLAUDE.md §39.
- Existing `admin` capabilities are unchanged for everything except role
  grants and the new `secrets.rotate` / `tenant.config.write` actions, which
  are now `super_admin`-only.
- The seed in `prisma/seed-super-admin.ts` makes `aashir@studymind.co.uk` the
  first `super_admin`. Clerk owns the password — our DB stores only the
  RoleAssignment.
- The DSL break-glass path (CLAUDE.md §21.1, §41.3) extends: in genuine
  emergency, only `super_admin` and `admin` can override DSL assignment for
  a `restricted_access` contact. This keeps day-to-day DSL work in the DSL
  team but acknowledges that the founder-level role retains break-glass.
