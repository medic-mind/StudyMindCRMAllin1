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
