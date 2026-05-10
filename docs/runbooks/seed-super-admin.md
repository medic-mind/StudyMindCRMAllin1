# Runbook: seed the initial super_admin

## Purpose

Bootstrap the very first `super_admin` user in a StudyMind CRM environment.
This is the role that can grant `admin` and `super_admin` to others
(CLAUDE.md §20, ADR 0009). Without it, nobody can manage users.

The default seed creates **`aashir@studymind.co.uk`** as `Aashir`.

## When to run

- On a brand-new database (production, staging, or a freshly reset dev DB).
- When restoring from a backup that pre-dates this script (one-off migration).
- When `aashir@studymind.co.uk` has been accidentally removed in production.

You do **not** need to run this every deploy — it is idempotent, but the
nightly seed already covers dev.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `INITIAL_SUPER_ADMIN_EMAIL` | `aashir@studymind.co.uk` | Email of the user to seed. |
| `INITIAL_SUPER_ADMIN_NAME` | `Aashir` | Display name (only used when creating a fresh row). |
| `INITIAL_SUPER_ADMIN_PASSWORD` | _unset_ | If set, bcrypt-hashed and stored. The user is forced to choose a new password on first sign-in (`mustResetPassword=true`). |
| `NEXT_PUBLIC_APP_URL` / `APP_URL` | `http://localhost:3000` | Used to build the accept-invite link in the link path. |

## What it does (high level)

1. Find or create a `User` row with the target email.
2. Idempotently ensure a `super_admin` `RoleAssignment` exists. If one is
   already there, the script reports `alreadySuperAdmin: true`.
3. One of:
   - **Password path** (`INITIAL_SUPER_ADMIN_PASSWORD` set): bcrypt-hash
     the password, set `emailVerifiedAt = now`, set
     `mustResetPassword = true`. The user signs in with the seeded password
     and is immediately routed to choose a new one.
   - **Link path** (no password set): leave `passwordHash = null`, issue an
     `EmailVerificationToken` with a 7-day TTL, and print the
     `/accept-invite?token=…` URL. Hand the link to the user out-of-band
     (1Password share or signed Slack DM); the URL itself contains the
     bearer token, so treat it as a credential.
4. Write an `auth.super_admin_seeded` audit entry.

## How to run

### Locally

```bash
pnpm seed:super-admin
```

Or, on a freshly reset DB, the regular seed does it for you:

```bash
pnpm db:seed
```

### Production / staging (Railway)

Run from a Railway shell on the `web` service so the env vars and DB URL
are already wired up:

```bash
INITIAL_SUPER_ADMIN_PASSWORD='…strong temporary password…' \
  pnpm seed:super-admin
```

Prefer the password path in production: it lets the user sign in and
choose their own password without any email round-trip.

If you must use the link path, copy the printed URL, deliver it via
1Password share to the recipient, then **delete the chat record**.

## Verifying success

1. The script's stdout contains `super_admin (granted)` (or
   `(already present)`) and either `password set from
   INITIAL_SUPER_ADMIN_PASSWORD` or an `accept-invite` URL.
2. `User` row visible in `prisma studio`:
   - `email = aashir@studymind.co.uk` (or the override)
   - `roleAssignments` contains one row with `role = super_admin`
3. An `AuditLogEntry` exists with `action = auth.super_admin_seeded`.
4. The user signs in successfully at `/sign-in` and lands at the
   "set new password" prompt (password path) or the `/accept-invite`
   page (link path).

## If the link expires

Tokens last 7 days. To re-issue:

1. Sign in as another `super_admin` (if one exists). From Settings →
   Users, click "resend invite" on Aashir's row.
2. If no other `super_admin` exists, re-run the seed script. It will
   detect that `passwordHash` is still null, issue a fresh token, and
   print a new URL. The previous token is **not** revoked automatically;
   either token will work until used or expired.

## Bootstrapping a fresh prod database from scratch

Order of operations:

1. Apply schema: `pnpm --filter @studymind/db exec prisma migrate deploy`.
2. Run the seed: `INITIAL_SUPER_ADMIN_PASSWORD='…' pnpm seed:super-admin`.
3. Sign in at `https://crm.studymind.co.uk/sign-in`. You will be forced
   to pick a new password.
4. From Settings → Users, invite the rest of the team. Use `super_admin`
   sparingly — `admin` is sufficient for everyday administration.

## Last-super_admin guard

The application enforces that you cannot revoke or deactivate the final
`super_admin` (CLAUDE.md §20, `assertNotLastSuperAdmin`). If you ever see
`LAST_SUPER_ADMIN` in production, add a second `super_admin` from this
runbook before resuming the operation that triggered the error.

## Related

- ADR 0009 — super_admin role and grant policy
- ADR 0010 — self-hosted auth
- CLAUDE.md §20 — RBAC matrix
- CLAUDE.md §40 — escalation contacts
