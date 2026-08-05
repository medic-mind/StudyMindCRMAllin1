# Runbook: create a full-admin CRM account

## Purpose

Create (or promote) a CRM login with full admin privileges — the `ceo` role
per ADR 0014 — for **any** email address, from the command line.

Use this when nobody can sign in yet, or when the normal route is unavailable.
The normal route is **Settings → Users** in the app (CLAUDE.md §20): a CEO or
Senior Manager creates the account there, and the user gets a branded welcome
email plus a credentials PDF. Prefer that whenever someone can already sign in.

## How this differs from `seed:super-admin`

|            | `pnpm seed:super-admin`                             | `pnpm create-admin`                                           |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Identity   | The ONE canonical CEO row, from `SUPER_ADMIN_*` env | Any email, passed as an argument                              |
| Runs       | Automatically on deploy                             | Manually, on demand                                           |
| Use it for | Bootstrapping a brand-new database                  | Adding a second/third admin, or recovering a specific account |

Using the seed to add a second admin means repointing the bootstrap identity on
every future deploy — that is what this script exists to avoid.

## Usage

```bash
# Generate a strong temporary password (printed once)
pnpm create-admin someone@example.com "Their Name"

# Or pin your own (>= 12 chars, 3 of 4 character classes)
ADMIN_PASSWORD='…strong…' pnpm create-admin someone@example.com

# Grant a different canonical role instead of ceo
ADMIN_ROLE=senior_manager pnpm create-admin someone@example.com
```

On Railway, run it from a shell on the **web** service so `DATABASE_URL` and
the rest of the env are already wired up.

## Environment variables

| Var                          | Default | Purpose                                                                                                                          |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_EMAIL`                | —       | Used when no CLI argument is given.                                                                                              |
| `ADMIN_NAME`                 | —       | Display name (create only).                                                                                                      |
| `ADMIN_ROLE`                 | `ceo`   | Any canonical role: `ceo`, `senior_manager`, `manager`, `sales_executive`, `virtual_assistant`. Legacy enum values are rejected. |
| `ADMIN_PASSWORD`             | _unset_ | Password to set. Omit on create and a strong one is generated and printed once.                                                  |
| `ADMIN_FORCE_PASSWORD_RESET` | _unset_ | `true` to overwrite an **existing** user's password (recovery). Requires `ADMIN_PASSWORD`.                                       |
| `ADMIN_SKIP_FORCE_RESET`     | _unset_ | `true` to NOT force a password change on first login.                                                                            |

## Behaviour

Mirrors the security posture of the CEO seed (2026-07 hardening):

- **New user** → created with `emailVerifiedAt = now` (no email round-trip) and
  `mustResetPassword = true`, so the temporary password must be changed on first
  login. The role is granted and both writes are audited.
- **Existing user** → the password is **left alone**. Re-running only ensures
  the role assignment exists, so the script is safe to repeat.
- **Recovery** → `ADMIN_PASSWORD` + `ADMIN_FORCE_PASSWORD_RESET=true` overwrites
  the password and clears any lockout or deactivation. This is the only path
  that changes an existing password (CLAUDE.md §3 — no silent mutation).
- A legacy `super_admin` assignment is converted to `ceo` in place rather than
  added alongside it, matching `seed-super-admin.ts`.

Audit rows written: `auth.user_created`, `auth.role_granted`,
`auth.password_reset_by_admin` (recovery only).

## After it runs

1. Sign in at `/sign-in` with the printed password.
2. **Two-factor enrolment is mandatory by default** (CLAUDE.md §20 — the
   `MANDATORY_MFA_ENABLED` default is "every staff role"), so the first stop is
   `/account/setup-2fa`. The CRM is unreachable until enrolment completes; not
   finishing never locks the account — sign out and you are prompted again.
3. You are then forced to choose a new password.

Deliver the temporary password via 1Password share, not chat or email. It is
printed once and never stored in plaintext.

## Verifying success

- stdout shows `admin account ready` with `role: ceo (granted)`.
- In `pnpm db:studio`: the `User` row exists and `roleAssignments` contains one
  row with `role = ceo`.
- An `AuditLogEntry` exists with `action = auth.user_created`.

## Related

- `docs/runbooks/seed-super-admin.md` — the CEO bootstrap seed
- `docs/runbooks/2fa-google-authenticator.md` — enrolment walkthrough
- ADR 0010 — self-hosted auth; ADR 0014 — the five canonical roles
- CLAUDE.md §20 — RBAC matrix and user management
