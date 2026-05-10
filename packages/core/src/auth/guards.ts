// Server-side guards for role-mutation flows. CLAUDE.md §20, ADR 0009.
//
// These run inside tRPC procedures (or seed scripts) AFTER policy
// allow-checks pass — they enforce per-row constraints that policy alone
// cannot capture, e.g. "do not leave the system with zero super_admins".

import { BusinessError } from '../errors'

/**
 * Minimal Prisma-shaped surface used by these guards. Keeping it narrow
 * lets the guards be unit-tested without a full PrismaClient.
 */
export interface RoleAssignmentCounter {
  roleAssignment: {
    count(args: {
      where: { role: 'super_admin'; userId?: { not: string } }
    }): Promise<number>
  }
}

/**
 * Throw `BusinessError('LAST_SUPER_ADMIN')` if revoking the super_admin
 * role from `userId` would leave zero active super_admins.
 *
 * Counts other users' super_admin assignments — if any exist we are safe.
 * The deactivate flow must call this before tearing down RoleAssignments.
 */
export async function assertNotLastSuperAdmin(
  db: RoleAssignmentCounter,
  userId: string,
): Promise<void> {
  const remaining = await db.roleAssignment.count({
    where: { role: 'super_admin', userId: { not: userId } },
  })
  if (remaining === 0) {
    throw new BusinessError(
      'LAST_SUPER_ADMIN',
      'cannot revoke the last super_admin',
      { userId },
    )
  }
}
