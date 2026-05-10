// Single-role picker for legacy ctx.user.role consumers. Highest-privilege
// role in the user's RoleAssignment list wins. Many call sites still gate on
// `user.role === 'admin'`; once they have all migrated to roles[] this helper
// can be deleted (ADR 0010).

import type { UserRole } from '@/lib/trpc/builders'

const ROLE_PRIORITY: UserRole[] = [
  'super_admin',
  'admin',
  'finance',
  'dsl',
  'ops_manager',
  'agent',
  'read_only',
]

export function pickPrimaryRole(roles: UserRole[]): UserRole {
  for (const r of ROLE_PRIORITY) if (roles.includes(r)) return r
  return 'read_only'
}
