// RBAC policy registry. Source of truth for the matrix in CLAUDE.md Section 20.1.
// See ADR 0009 for the super_admin addition.

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
  'safeguarding.flag',
  'safeguarding.read_notes',
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
// Attribute checks (e.g. assigned DSL only) are layered on top in domain code.
// Actions that require a per-row attribute check on top of the role grant.
// `safeguarding.read_notes` is gated on the caller being the assigned DSL of
// the SafeguardingFlag, and every read writes an AuditLogEntry. CLAUDE.md §20.1.
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
  'safeguarding.flag': false,
  'safeguarding.read_notes': true,
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
  'safeguarding.flag': true,
  'safeguarding.read_notes': true,
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
  'safeguarding.flag',
  'safeguarding.read_notes',
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
    'safeguarding.flag',
    'audit.read',
  ]),
  agent: new Set<Action>([
    'contact.read',
    'contact.read_minor',
    'contact.write',
    'interaction.create',
    'charge.create_link',
    'safeguarding.flag',
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
  dsl: new Set<Action>([
    'contact.read',
    'contact.read_minor',
    'interaction.create',
    'safeguarding.flag',
    'safeguarding.read_notes',
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
 * Whether the role can override DSL assignment on a `restricted_access`
 * SafeguardingFlag in genuine emergency. CLAUDE.md §21.1, §41.3, ADR 0009.
 *
 * Day-to-day DSL work stays in the DSL team; this is a break-glass capability
 * reserved for the founder-level role and admins. Every override writes an
 * AuditLogEntry and pings the on-call DSL via Slack (Section 21.1).
 */
export function canOverrideRestrictedDsl(actorRole: Role): boolean {
  return actorRole === 'super_admin' || actorRole === 'admin'
}
