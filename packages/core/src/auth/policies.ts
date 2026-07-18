// RBAC policy registry. Source of truth for the matrix in CLAUDE.md Section 20.1.
// See ADR 0014 for the sales-CRM role rename (supersedes ADR 0009).
// See ADR 0013 for the removal of safeguarding actions.

/**
 * Canonical sales-CRM roles (ADR 0014). The five names below are the only
 * roles new code should reason about. Legacy enum values (super_admin, admin,
 * ops_manager, agent, finance, dsl, read_only) remain in the Postgres enum
 * per CLAUDE.md §19 forward-only rule and are normalised to a canonical Role
 * by `pickPrimaryRole`.
 */
export const ROLES = [
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
] as const

export type Role = (typeof ROLES)[number]

/**
 * Legacy role names retained for defence in depth. RoleAssignment rows in
 * production are bulk-migrated by 20260524120100_migrate_sales_roles, but
 * `pickPrimaryRole` continues to accept these values so a stray legacy row
 * (e.g. a fixture, a misconfigured seed) is still mapped to a canonical
 * Role at read time.
 */
export const LEGACY_ROLES = [
  'super_admin',
  'admin',
  'ops_manager',
  'agent',
  'finance',
  'dsl',
  'read_only',
] as const

export type LegacyRole = (typeof LEGACY_ROLES)[number]

/** Any value that may appear in `RoleAssignment.role`. */
export type AnyRole = Role | LegacyRole

export const ACTIONS = [
  'contact.read',
  'contact.read_minor',
  'contact.write',
  'family.merge',
  'interaction.create',
  'interaction.delete',
  'charge.create_link',
  'charge.refund',
  'subscription.cancel',
  'dsar.export',
  'audit.read',
  'settings.write',
  // User management. Slice 14 (ADR 0009) introduced these; ADR 0014 renames
  // the grant/revoke verbs to the new role names; ADR 0021 adds account
  // editing (`user.manage`) and the right to delegate it (`user.grant_manage`).
  'user.invite',
  'user.manage',
  'user.grant_manage',
  'user.deactivate',
  'user.role.grant_senior_manager',
  'user.role.grant_ceo',
  'user.role.revoke_senior_manager',
  'secrets.rotate',
  'tenant.config.write',
] as const

export type Action = (typeof ACTIONS)[number]

// Whether a role is granted an action by default.
// Attribute checks (e.g. minor-DOB) are layered on top in domain code.
export const ATTRIBUTE_GATED_ACTIONS: Readonly<Record<Action, boolean>> = {
  'contact.read': false,
  'contact.read_minor': true,
  'contact.write': false,
  'family.merge': false,
  'interaction.create': false,
  'interaction.delete': false,
  'charge.create_link': false,
  'charge.refund': false,
  'subscription.cancel': false,
  'dsar.export': false,
  'audit.read': false,
  'settings.write': false,
  'user.invite': false,
  'user.manage': false,
  'user.grant_manage': false,
  'user.deactivate': false,
  'user.role.grant_senior_manager': false,
  'user.role.grant_ceo': false,
  'user.role.revoke_senior_manager': false,
  'secrets.rotate': false,
  'tenant.config.write': false,
}

export const AUDIT_REQUIRED_ACTIONS: Readonly<Record<Action, boolean>> = {
  'contact.read': false,
  'contact.read_minor': true,
  'contact.write': true,
  'family.merge': true,
  'interaction.create': true,
  'interaction.delete': true,
  'charge.create_link': true,
  'charge.refund': true,
  'subscription.cancel': true,
  'dsar.export': true,
  'audit.read': false,
  'settings.write': true,
  'user.invite': true,
  'user.manage': true,
  'user.grant_manage': true,
  'user.deactivate': true,
  'user.role.grant_senior_manager': true,
  'user.role.grant_ceo': true,
  'user.role.revoke_senior_manager': true,
  'secrets.rotate': true,
  'tenant.config.write': true,
}

// Senior Manager inherits every operational and financial action; only the
// ceo-tier grants (and tenant/secret rotation) are reserved for ceo.
const SENIOR_MANAGER_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'contact.read',
  'contact.read_minor',
  'contact.write',
  'family.merge',
  'interaction.create',
  'interaction.delete',
  'charge.create_link',
  'charge.refund',
  'subscription.cancel',
  'dsar.export',
  'audit.read',
  'settings.write',
  'user.invite',
  'user.manage',
  'user.grant_manage',
  'user.deactivate',
  'user.role.revoke_senior_manager',
])

// Manager: sales + finance ops. Can refund, create payment links, manage
// allocations. Can edit user details + reset passwords (`user.manage`) and
// delegate that right to an individual (`user.grant_manage`) — but CANNOT
// create accounts (ADR 0021: creation is CEO + Senior Manager only),
// deactivate peers, or write tenant-wide settings.
const MANAGER_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'contact.read',
  'contact.read_minor',
  'contact.write',
  'family.merge',
  'interaction.create',
  'charge.create_link',
  'charge.refund',
  'subscription.cancel',
  'audit.read',
  'user.manage',
  'user.grant_manage',
])

// Sales Executive: full CRUD on Contacts/Families/Tasks/Interactions; sends
// payment links. NEVER issues refunds (route to Manager+).
const SALES_EXECUTIVE_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'contact.read',
  'contact.read_minor',
  'contact.write',
  'interaction.create',
  'charge.create_link',
])

// Virtual Assistant: read-mostly. May write Interactions (notes, drafts).
// Cannot send messages, issue refunds, or change billing — those gates live
// in the relevant routers (outbound send + charge.refund).
const VIRTUAL_ASSISTANT_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'contact.read',
  'interaction.create',
])

export const ROLE_GRANTS: Readonly<Record<Role, ReadonlySet<Action>>> = {
  ceo: new Set<Action>(ACTIONS),
  senior_manager: SENIOR_MANAGER_ACTIONS,
  manager: MANAGER_ACTIONS,
  sales_executive: SALES_EXECUTIVE_ACTIONS,
  virtual_assistant: VIRTUAL_ASSISTANT_ACTIONS,
}

export function roleCan(role: Role, action: Action): boolean {
  return ROLE_GRANTS[role].has(action)
}

/**
 * Whether `actorRole` is allowed to grant or revoke `targetRole`.
 *
 * - `ceo` may grant or revoke any role (including another `ceo`).
 * - `senior_manager` may grant or revoke `manager`, `sales_executive`,
 *   `virtual_assistant`. They MAY NOT grant or revoke `ceo` or another
 *   `senior_manager` (separation of duties — only ceo can mint a peer).
 * - All other roles are denied.
 *
 * Used by both `assignRole` and `revokeRole` so the gate is symmetric.
 * CLAUDE.md §20, ADR 0014.
 */
export function canGrantRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'ceo') return true
  if (actorRole === 'senior_manager') {
    return (
      targetRole === 'manager' ||
      targetRole === 'sales_executive' ||
      targetRole === 'virtual_assistant'
    )
  }
  return false
}

/**
 * Whether `actorRole` is allowed to revoke `targetRole`.
 *
 * Symmetric with `canGrantRole`: if you cannot grant a role you cannot
 * unilaterally revoke it either. CLAUDE.md §20, ADR 0014.
 */
export function canRevokeRole(actorRole: Role, targetRole: Role): boolean {
  return canGrantRole(actorRole, targetRole)
}

/* -------------------------------------------------------------------------- */
/* Grantable per-user permissions (ADR 0021)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Actions a privileged user can hand to an individual via a `UserPermission`
 * row, layered on top of the role matrix. Today the only grantable action is
 * `user.manage` (edit details / change email / reset another user's password).
 * Account creation, role grants and deactivation are deliberately NOT
 * grantable — they stay role-gated.
 */
export const GRANTABLE_ACTIONS = ['user.manage'] as const
export type GrantableAction = (typeof GRANTABLE_ACTIONS)[number]

export function isGrantableAction(value: string): value is GrantableAction {
  return (GRANTABLE_ACTIONS as readonly string[]).includes(value)
}

/* -------------------------------------------------------------------------- */
/* Custom roles — assignable permission bundles (§20 follow-on)               */
/* -------------------------------------------------------------------------- */

/**
 * Actions that must NEVER be delegated through a custom role or a per-user
 * grant — they stay locked to the built-in senior roles. Each maps to org
 * takeover, data exfiltration, or a separation-of-duties boundary:
 *  - `secrets.rotate` / `tenant.config.write` — org-wide secrets + config.
 *  - `user.role.*` — minting/removing CEO / Senior Manager peers.
 *  - `user.deactivate` — locking peers out.
 *  - `user.invite` — creating accounts (CEO + Senior Manager only, ADR 0021).
 *  - `user.grant_manage` — delegating the delegation right.
 *  - `dsar.export` — bulk personal-data export.
 */
export const DENY_LIST_ACTIONS = [
  'secrets.rotate',
  'tenant.config.write',
  'user.role.grant_ceo',
  'user.role.grant_senior_manager',
  'user.role.revoke_senior_manager',
  'user.deactivate',
  'user.invite',
  'user.grant_manage',
  'dsar.export',
] as const satisfies readonly Action[]

/**
 * The safe subset an admin may put into a custom role (or a per-user grant):
 * every ACTION except the catastrophic deny-list above.
 */
export const ASSIGNABLE_ACTIONS: readonly Action[] = ACTIONS.filter(
  (a) => !(DENY_LIST_ACTIONS as readonly string[]).includes(a),
)

export function isAssignableAction(value: string): value is Action {
  return (ASSIGNABLE_ACTIONS as readonly string[]).includes(value)
}

/**
 * Sanitise a requested permission set for a custom role / grant. Enforces the
 * two safety guarantees:
 *  1. Only assignable actions survive — the deny-list can never be bundled.
 *  2. No privilege escalation — an actor may only include a permission they
 *     THEMSELVES currently hold (`actorEffective` = the actor's own effective
 *     actions). A Manager cannot mint a role that does what a Manager cannot.
 * Returns the deduped, sorted, allowed subset.
 */
export function sanitizeRolePermissions(
  actorEffective: readonly string[],
  requested: readonly string[],
): Action[] {
  const held = new Set(actorEffective)
  const out = new Set<Action>()
  for (const p of requested) {
    if (isAssignableAction(p) && held.has(p)) out.add(p)
  }
  return [...out].sort()
}

/** Friendly label for each action — used by the permission-catalogue UI. */
export const ACTION_LABELS: Readonly<Record<Action, string>> = {
  'contact.read': 'View contacts',
  'contact.read_minor': 'View minor profiles',
  'contact.write': 'Create / edit contacts',
  'family.merge': 'Merge families',
  'interaction.create': 'Add notes / interactions',
  'interaction.delete': 'Delete interactions',
  'charge.create_link': 'Send payment links',
  'charge.refund': 'Issue refunds',
  'subscription.cancel': 'Cancel subscriptions',
  'dsar.export': 'Export DSAR data',
  'audit.read': 'Read the audit log',
  'settings.write': 'Change settings',
  'user.invite': 'Create accounts',
  'user.manage': 'Edit users / reset passwords',
  'user.grant_manage': 'Delegate user management',
  'user.deactivate': 'Deactivate users',
  'user.role.grant_senior_manager': 'Grant Senior Manager',
  'user.role.grant_ceo': 'Grant CEO',
  'user.role.revoke_senior_manager': 'Revoke Senior Manager',
  'secrets.rotate': 'Rotate secrets',
  'tenant.config.write': 'Write tenant config',
}

/** Grouping for the permission-catalogue + matrix UI (order matters). */
export const ACTION_GROUPS: ReadonlyArray<{ label: string; actions: readonly Action[] }> = [
  {
    label: 'Contacts & timeline',
    actions: [
      'contact.read',
      'contact.read_minor',
      'contact.write',
      'family.merge',
      'interaction.create',
      'interaction.delete',
    ],
  },
  {
    label: 'Finance',
    actions: ['charge.create_link', 'charge.refund', 'subscription.cancel'],
  },
  { label: 'Admin & data', actions: ['audit.read', 'settings.write', 'dsar.export'] },
  {
    label: 'User management',
    actions: [
      'user.invite',
      'user.manage',
      'user.grant_manage',
      'user.deactivate',
      'user.role.grant_senior_manager',
      'user.role.grant_ceo',
      'user.role.revoke_senior_manager',
      'secrets.rotate',
      'tenant.config.write',
    ],
  },
]

/**
 * Effective permission check. An actor may perform `action` if their role
 * grants it OR they hold a matching **assignable** permission (from a custom
 * role or a per-user grant). `granted` is the actor's effective granted
 * actions (`loadEffectiveGrants`). Deny-list actions are never assignable, so
 * they can only ever be satisfied by the base role.
 */
export function hasAction(
  role: Role,
  granted: readonly string[],
  action: Action,
): boolean {
  if (roleCan(role, action)) return true
  return isAssignableAction(action) && granted.includes(action)
}

/**
 * Who can CREATE accounts (temp-password create + link invite): CEO and
 * Senior Manager only. Not grantable to individuals. ADR 0021.
 */
export function canCreateUsers(role: Role): boolean {
  return roleCan(role, 'user.invite')
}

/**
 * Who can edit details / change email / reset another user's password:
 * any role that grants `user.manage` (CEO, Senior Manager, Manager) OR an
 * individual who has been granted the `user.manage` permission. ADR 0021.
 */
export function canManageUsers(role: Role, granted: readonly string[]): boolean {
  return hasAction(role, granted, 'user.manage')
}

/** Who can grant/revoke the `user.manage` permission: CEO, Senior Manager, Manager. */
export function canGrantUserManage(role: Role): boolean {
  return roleCan(role, 'user.grant_manage')
}

/** Who can deactivate / reactivate users: CEO + Senior Manager. */
export function canDeactivateUsers(role: Role): boolean {
  return roleCan(role, 'user.deactivate')
}

/**
 * Canonical priority order used by `pickPrimaryRole`. Highest privilege wins.
 */
const ROLE_PRIORITY: readonly Role[] = [
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
]

/**
 * Exhaustive mapping from every legacy enum value to a canonical Role.
 * Must stay exhaustive — if a new legacy alias appears it MUST be added here
 * so existing rows behave correctly until the bulk data migration runs.
 */
const LEGACY_ROLE_MAP: Readonly<Record<LegacyRole, Role>> = {
  super_admin: 'ceo',
  admin: 'senior_manager',
  ops_manager: 'manager',
  finance: 'manager',
  dsl: 'manager',
  agent: 'sales_executive',
  read_only: 'virtual_assistant',
}

function isCanonicalRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}

function isLegacyRole(value: string): value is LegacyRole {
  return (LEGACY_ROLES as readonly string[]).includes(value)
}

/** Normalise an arbitrary role string to its canonical Role, or null. */
export function normaliseRole(role: string): Role | null {
  if (isCanonicalRole(role)) return role
  if (isLegacyRole(role)) return LEGACY_ROLE_MAP[role]
  return null
}

/**
 * Pick the highest-privilege canonical Role from a user's RoleAssignment
 * list. Accepts both canonical and legacy values; legacy values are mapped
 * via `LEGACY_ROLE_MAP`. Always returns a canonical Role — defaults to
 * `virtual_assistant` (the least-privileged role) when the list is empty
 * or contains only unrecognised strings.
 */
export function pickPrimaryRole(roles: readonly string[]): Role {
  const canonical = new Set<Role>()
  for (const r of roles) {
    const c = normaliseRole(r)
    if (c) canonical.add(c)
  }
  for (const r of ROLE_PRIORITY) {
    if (canonical.has(r)) return r
  }
  return 'virtual_assistant'
}
