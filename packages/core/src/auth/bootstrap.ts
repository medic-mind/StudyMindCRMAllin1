// Pure readers for the first-run setup page. The page itself lives in
// apps/web/app/(auth)/setup and is restricted by ESLint from importing
// @studymind/db directly — these helpers are the supported indirection.
//
// ADR 0010, CLAUDE.md §20.

import type { Prisma, PrismaClient } from '@prisma/client'

export type DbClient = PrismaClient | Prisma.TransactionClient

export type BootstrapStatus =
  /** A super_admin with a passwordHash exists. Setup is closed. */
  | { status: 'closed' }
  /** A super_admin user has been seeded but no password is set. */
  | { status: 'open'; candidateEmail: string }
  /** No super_admin user has been seeded yet. */
  | { status: 'no_user' }

/**
 * Read-only inspection of the bootstrap state. Used by the /setup page
 * to decide whether to render the claim form, a "no user seeded" hint,
 * or 404.
 */
export async function readBootstrapStatus(
  db: DbClient,
): Promise<BootstrapStatus> {
  const claimed = await db.user.findFirst({
    where: {
      passwordHash: { not: null },
      deletedAt: null,
      roleAssignments: { some: { role: 'super_admin' } },
    },
    select: { id: true },
  })
  if (claimed) return { status: 'closed' }

  const candidate = await db.user.findFirst({
    where: {
      deletedAt: null,
      passwordHash: null,
      roleAssignments: { some: { role: 'super_admin' } },
    },
    select: { email: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!candidate) return { status: 'no_user' }
  return { status: 'open', candidateEmail: candidate.email }
}
