// RBAC policy registry. Source of truth for the matrix in CLAUDE.md Section 20.1.
// See ADR 0009 for the super_admin addition.
// See ADR 0013 for the removal of safeguarding actions.

export const ROLES = [
  'super_admin',
  'admin',
  'ops_manager',
  'agent',
  'finance',
  'dsl',
  'read_only',
] as const

export type Role = (typeof ROLES)[number]

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
  // User management (Slice 14, ADR 0009).
  'user.invite',
  'user.deactivate',
  'user.role.grant_admin',
  'user.role.grant_super_admin',
  'user.role.revoke_admin',
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
  'user.role.grant_admin': false,
  'user.role.grant_super_admin': false,
  'user.role.revoke_admin': false,
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
  'user.role.grant_admin': true,
  'user.role.grant_super_admin': true,
  'user.role.revoke_admin': true,
  'secrets.rotate': true,
  'tenant.config.write': true,
}

const ADMIN_ACTIONS: ReadonlySet<Action> = new Set<Action>([
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
])

export const ROLE_GRANTS: Readonly<Record<Role, ReadonlySet<Action>>> = {
  super_admin: new Set<Action>(ACTIONS),
  admin: ADMIN_ACTIONS,
  ops_manager: new Set<Action>([
    'contact.read',
    'contact.read_minor',
    'contact.write',
    'family.merge',
    'interaction.create',
    'charge.create_link',
    'subscription.cancel',
    'audit.read',
  ]),
  agent: new Set<Action>([
    'contact.read',
    'contact.read_minor',
    'contact.write',
    'interaction.create',
    'charge.create_link',
  ]),
  finance: new Set<Action>([
    'contact.read',
    'contact.read_minor',
    'interaction.create',
    'charge.create_link',
    'charge.refund',
    'subscription.cancel',
    'audit.read',
  ]),
  // dsl retained as an enum value (forward-only schema, CLAUDE.md §19) but
  // safeguarding actions are gone (ADR 0013). dsl now collapses to a
  // read-only Contact role until the slice-2 rename to Manager.
  dsl: new Set<Action>([
    'contact.read',
    'contact.read_minor',
    'interaction.create',
    'audit.read',
  ]),
  read_only: new Set<Action>(['contact.read']),
}

export function roleCan(role: Role, action: Action): boolean {
  return ROLE_GRANTS[role].has(action)
}

/**
 * Whether `actorRole` is allowed to grant or revoke `targetRole`.
 *
 * - `super_admin` can grant any role (including another `super_admin`).
 * - `admin` can grant any role EXCEPT `admin` and `super_admin`.
 *   This prevents self-elevation: an `admin` cannot mint another `admin`
 *   (separation of duties — see ADR 0009).
 * - All other roles are denied.
 *
 * Used by both `assignRole` and `revokeRole` so the gate is symmetric.
 * CLAUDE.md §20, ADR 0009.
 */
export function canGrantRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'super_admin') return true
  if (actorRole === 'admin') {
    return targetRole !== 'admin' && targetRole !== 'super_admin'
  }
  return false
}

/**
 * Whether `actorRole` is allowed to revoke `targetRole`.
 *
 * Symmetric with `canGrantRole`: if you cannot grant a role you cannot
 * unilaterally revoke it either. CLAUDE.md §20, ADR 0009.
 */
export function canRevokeRole(actorRole: Role, targetRole: Role): boolean {
  return canGrantRole(actorRole, targetRole)
}
