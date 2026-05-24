# ADR 0014: Rename the role system to sales-focused vocabulary

- Status: Accepted
- Date: 2026-05-24
- Supersedes: ADR 0009

## Context

The StudyMind All in One CRM has pivoted to a sales-first v1 (ADR 0011 dropped
the LA tender flow; ADR 0013 dropped the safeguarding workflow). The role
vocabulary that survived from the original product —
`super_admin`, `admin`, `ops_manager`, `agent`, `finance`, `dsl`, `read_only` —
does not match how the team now describes itself.

In the new world there are five jobs that map cleanly onto how the business
thinks about who can do what:

- **CEO** — the founder. Only role allowed to mint another CEO or a Senior
  Manager, rotate org-wide secrets, and write tenant config.
- **Senior Manager** — runs the team day to day. Can grant or revoke any role
  *below* CEO. Full access to every operational and financial surface.
- **Manager** — sales + finance ops. Issues refunds, creates payment links,
  reviews allocations, invites Sales Executives and Virtual Assistants.
- **Sales Executive** — the front-line: full CRUD on Contacts, Families, Tasks,
  Interactions; sends payment links; cannot issue refunds (route to Manager+).
- **Virtual Assistant** — read-mostly. Writes notes, drafts replies, cannot
  send messages, issue refunds, or change billing.

The old 7-role enum was also accreting historical baggage: `dsl` survives as
an enum value (CLAUDE.md §19 forward-only) but the safeguarding actions it
gated are gone, so today it just means "a manager who can read audit logs".
Collapsing the three middle roles into a single `manager` is what the team
actually does.

## Decision

Rename to the five-role hierarchy above. Canonical Postgres enum values:
`ceo`, `senior_manager`, `manager`, `sales_executive`, `virtual_assistant`.
UI labels are friendlier ("CEO", "Senior Manager", "Manager", "Sales
Executive", "Virtual Assistant") via a `formatRoleLabel` helper.

Migration mapping:

| Legacy        | New                |
| ------------- | ------------------ |
| super_admin   | ceo                |
| admin         | senior_manager     |
| ops_manager   | manager            |
| finance       | manager            |
| dsl           | manager            |
| agent         | sales_executive    |
| read_only     | virtual_assistant  |

The legacy enum values stay in the `UserRole` enum forever (CLAUDE.md §19
forward-only). `pickPrimaryRole` in `apps/web/lib/auth/pick-primary-role.ts`
canonicalises any straggler legacy assignment at read time, so the system
remains correct if a row is somehow inserted under an old name.

`canGrantRole`/`canRevokeRole` are rewritten symmetrically:

- `ceo` may grant or revoke any role.
- `senior_manager` may grant or revoke `manager`, `sales_executive`,
  `virtual_assistant` — never `ceo` or another `senior_manager`.
- Everyone else: deny.

A new `assertNotLastCeo` guard replaces `assertNotLastSuperAdmin` everywhere
it is called (admin user-management revoke + deactivate flows).

## Consequences

- CLAUDE.md §20 is rewritten to describe the new five roles and friendly
  labels. The §20.1 matrix regenerates from `packages/core/auth/policies.ts`
  via `pnpm policy:check`.
- ADR 0009 is marked Superseded.
- Two-PR schema dance (CLAUDE.md §19.1): one migration appends the new enum
  values, a second migration runs the bulk `UPDATE`. The legacy values stay.
- Every server-side role gate calls `canGrantRole`/`canRevokeRole`; UI hides
  options the actor cannot act on.
- The `Finance` nav item is now visible to `ceo`, `senior_manager`, `manager`
  only — Sales Executives no longer see it (they could create payment links
  via the contact detail UI, never the dashboard).
- `Settings` is visible to `ceo` and `senior_manager` only.
- Privileged-role MFA gate (`MANDATORY_MFA_ENABLED`) covers `ceo`,
  `senior_manager`, `manager` — the three roles that can move money or
  manage people.
- The `safeguarding`, `dsar`, and `tender` actions retained in
  `packages/core/auth/policies.ts` from earlier slices keep working: Manager
  inherits the old `finance` + `dsl` + `ops_manager` grants where they made
  sense; `ceo` and `senior_manager` inherit everything `admin` had.
