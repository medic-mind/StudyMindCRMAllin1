// Server-side guards for role-mutation flows. CLAUDE.md §20, ADR 0014.
//
// These run inside tRPC procedures (or seed scripts) AFTER policy
// allow-checks pass — they enforce per-row constraints that policy alone
// cannot capture, e.g. "do not leave the system with zero ceos".

import { BusinessError } from '../errors'

/**
 * Minimal Prisma-shaped surface used by these guards. Keeping it narrow
 * lets the guards be unit-tested without a full PrismaClient.
 *
 * The `role` column accepts both the canonical role names (ceo,
 * senior_manager, ...) and the retained legacy aliases (super_admin, ...).
 * The guard counts BOTH `ceo` and the legacy `super_admin` so a partially-
 * migrated database remains correct.
 */
export interface RoleAssignmentCounter {
  roleAssignment: {
    // Intentionally loose — PrismaClient's generated `count` signature is
    // wider than we need, and any narrower shape collides with it when the
    // real client is passed in. Domain code constructs the `where` clause
    // below; test doubles supply a `count` that ignores its argument.
    count(args: { where: object }): Promise<number>
  }
}

const CEO_ROLE_VALUES = ['ceo', 'super_admin'] as const

/**
 * Throw `BusinessError('LAST_CEO')` if revoking the ceo role from `userId`
 * would leave zero active ceos in the system.
 *
 * Counts every other user's `ceo` (or legacy `super_admin`) assignment —
 * if any exist we are safe. The deactivate flow must call this before
 * tearing down RoleAssignments. ADR 0014.
 */
export async function assertNotLastCeo(
  db: RoleAssignmentCounter,
  userId: string,
): Promise<void> {
  const remaining = await db.roleAssignment.count({
    where: { role: { in: CEO_ROLE_VALUES }, userId: { not: userId } },
  })
  if (remaining === 0) {
    throw new BusinessError('LAST_CEO', 'cannot revoke the last ceo', { userId })
  }
}
