// Effective granted actions for a user: per-user `UserPermission` grants ∪
// every assigned (non-archived) custom role's permissions, deduped. This is
// what `hasAction` / `ctx.can` consult so custom roles (and per-user grants)
// take effect wherever a gate checks an action. CLAUDE.md §20.

import type { PrismaClient } from '@studymind/db'

type Db = Pick<PrismaClient, 'userPermission' | 'userCustomRole'>

export async function loadEffectiveGrants(db: Db, userId: string): Promise<string[]> {
  const [perms, roles] = await Promise.all([
    db.userPermission.findMany({ where: { userId }, select: { permission: true } }),
    db.userCustomRole.findMany({
      where: { userId, customRole: { archivedAt: null } },
      select: { customRole: { select: { permissions: true } } },
    }),
  ])
  const set = new Set<string>()
  for (const p of perms) set.add(p.permission)
  for (const r of roles) for (const a of r.customRole.permissions) set.add(a)
  return [...set]
}
