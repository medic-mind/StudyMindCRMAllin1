// Single-role picker for ctx.user.role consumers. Highest-privilege canonical
// role in the user's RoleAssignment list wins. Legacy role names (super_admin,
// admin, ops_manager, agent, finance, dsl, read_only) are mapped to their
// canonical successors per ADR 0014. Defaults to virtual_assistant on empty
// input.
//
// Implementation lives in @studymind/core; this re-export keeps the existing
// import path (`@/lib/auth/pick-primary-role`) working unchanged.

import { pickPrimaryRole as corePickPrimaryRole, type Role } from '@studymind/core/auth/policies'

import type { UserRole } from '@/lib/trpc/builders'

export function pickPrimaryRole(roles: readonly string[]): UserRole {
  return corePickPrimaryRole(roles) as Role & UserRole
}
