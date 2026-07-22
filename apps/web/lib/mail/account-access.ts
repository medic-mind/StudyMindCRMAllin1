// Per-mailbox access boundary for the Communications Hub (ADR 0021).
//
// Personal mailboxes are private to their owner; shared inboxes are limited to
// their `MailAccountMember`s; CEO / Senior Manager / Manager may see all. This
// predicate is the SINGLE source of truth used by every per-account read, send
// and mutation across `mail.*` and `inbox.conversations.*` — the boundary must
// hold on individual thread/account access, not only on listings (otherwise any
// staffer can read or send from any mailbox by passing its id).

import type { PrismaClient } from '@prisma/client'

const MANAGE_MAIL_ROLES: ReadonlySet<string> = new Set(['ceo', 'senior_manager', 'manager'])

export async function canAccessMailAccount(
  db: PrismaClient,
  actor: { id: string; role: string },
  mailAccountId: string | null | undefined,
): Promise<boolean> {
  if (MANAGE_MAIL_ROLES.has(actor.role)) return true
  if (!mailAccountId) return false
  const acc = await db.mailAccount.findFirst({
    where: { id: mailAccountId, deletedAt: null },
    select: { ownerUserId: true },
  })
  if (acc?.ownerUserId && acc.ownerUserId === actor.id) return true
  const member = await db.mailAccountMember.findFirst({
    where: { mailAccountId, userId: actor.id },
    select: { mailAccountId: true },
  })
  return member != null
}
