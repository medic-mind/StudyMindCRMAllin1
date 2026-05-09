// RBAC policy registry. Source of truth for the matrix in CLAUDE.md Section 20.1.

export const ROLES = [
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
}

export const ROLE_GRANTS: Readonly<Record<Role, ReadonlySet<Action>>> = {
  admin: new Set<Action>(ACTIONS),
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
