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
  // the grant/revoke verbs to the new role names.
  'user.invite',
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
  'user.deactivate',
  'user.role.revoke_senior_manager',
])

// Manager: sales + finance ops. Can refund, create payment links, manage
// allocations. Invites Sales Executives and Virtual Assistants (the grant
// matrix in canGrantRole gates which roles they may mint). Cannot deactivate
// peers and cannot write tenant-wide settings.
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
  'user.invite',
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
