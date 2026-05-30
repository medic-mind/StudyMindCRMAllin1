# ADR 0021 — User management: admin-created accounts, delegated permission, welcome credentials

- Status: Accepted & implemented
- Date: 2026-05-30
- Supersedes: none
- Related: ADR 0010 (self-hosted auth), ADR 0014 (sales-role rename), CLAUDE.md §20

## Context

We need a complete staff user-management system. The constraints from the
product owner:

1. **Only Senior Managers and CEOs may create accounts.** No self-service
   sign-up.
2. Senior Managers, CEOs **and Managers** may reset passwords, change emails,
   and edit details — and an **individual** can be _given_ that permission by a
   Manager, Senior Manager or CEO without changing their role.
3. Users can reset their own password (self-service forgot/reset already
   exists, ADR 0010).
4. When an account is created the user is emailed confirmation with their
   initial login details, delivered as a **proper templated email with a PDF
   attachment**.
5. Outbound from `info@studymind.co.uk` (to be connected).

ADR 0010 already gives us NextAuth v5 + bcrypt passwords, server-side sessions,
the `mustResetPassword` gate + `/account/change-password`, account lockout,
single-use email/reset tokens, and an `admin.users.*` router (list / get /
invite / role grant-revoke / deactivate), and a per-agent Gmail OAuth
integration (ADR 0012) for outbound mail. There was no system-email path for
fresh (non-reply) messages with HTML + attachments.

## Decision

**Credential delivery — temporary password.** Account creation
(`admin.users.create`) and admin-triggered reset (`admin.users.resetPassword`)
generate a strong, human-transcribable temporary password
(`generateTemporaryPassword`, always passes the existing strength policy,
avoids 0/O/1/l/I). We set it, force `mustResetPassword`, mark the email
verified (an admin vouches for the address), and email a branded welcome/reset
message with a **credentials PDF** attached. The plaintext temp password is
also returned to the creating admin so accounts are usable before the outbound
mailbox is connected. It is never logged.

**Permission model.** Two new actions in `packages/core/src/auth/policies.ts`:

- `user.manage` — edit details / change email / reset password. Held by role by
  CEO, Senior Manager, Manager; **grantable to any individual** via a
  `UserPermission` row. It is the sole member of `GRANTABLE_ACTIONS`.
- `user.grant_manage` — delegate `user.manage`. Held by CEO/Senior Manager/Manager.

`user.invite` is removed from Manager (creation is CEO + Senior Manager only).
Deactivation and role grants stay CEO + Senior Manager. A non-(CEO/Senior
Manager) actor may never act on a CEO or Senior Manager account
(`assertCanActOnTarget`). Effective checks use
`canManageUsers(role, grantedPermissions)`; the router reads grants from the DB
per call (fresh, no session/JWT changes) and exposes `admin.users.myAccess` so
the UI can gate itself.

**Email + PDF — Gmail OAuth, never Resend.** Per the product owner, we do not
use any third-party email API. `packages/integrations/gmail/src/system-send.ts`
adds `sendSystemEmail` — a fresh (non-reply) RFC 5322 builder supporting HTML +
attachments, sent through a connected Gmail mailbox resolved from
`SYSTEM_GMAIL_EMAIL` (default `info@studymind.co.uk`), falling back to any
connected default mailbox and skipping gracefully when none is connected (the
admin still sees the temp password in the UI). All previous Resend call sites
(welcome/reset, self-service forgot/verify, forwarding) now go through it, and
the `@studymind/integration-resend` package is removed. Templates and a
**first-party, dependency-free PDF writer** live in `packages/core/src/email/`
(pure builders). We hand-rolled the PDF (one page, built-in Helvetica,
ASCII-safe) rather than add a library, per CLAUDE.md §35/§44.1 on
dependency/supply-chain discipline. The only PDF we produce is a short text
credentials sheet, so a library is not warranted.

**Self-service sign-up is disabled.** The `/sign-up` route is removed, the
`signUp` server action is a hard-disabled stub (regression-tested), and the
sign-in form no longer links to it.

## Schema

New `UserPermission` (`userId`, `permission`, `createdById`, unique
`(userId, permission)`), migration `20260603120000_add_user_permissions`.
Forward-only (§19); `permission` is text, validated by Zod against
`GRANTABLE_ACTIONS` at the boundary.

## Consequences

- Every new mutation is audited (`auth.user_created`, `auth.user_updated`,
  `auth.password_reset_by_admin`, `auth.permission_granted` /
  `auth.permission_revoked`) and registered in the event registry.
- Managers and permission-holders can now view the user list and manage
  non-leadership users; the server re-checks every action.
- A privileged actor sees the temp password once at create/reset time — a
  deliberate trade-off the product owner chose over a link-only flow, made safe
  by forced first-login reset and session invalidation on reset.
- The legacy link-based `invite` flow is retained as an alternative (CEO/SM).
