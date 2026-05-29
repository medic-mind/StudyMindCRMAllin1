// Mailbox lookup helpers. Multi-mailbox per agent (CLAUDE.md §14): the
// default mailbox drives the agent's outbound + the per-contact features
// that need a single inbox (Trengo/board call-summary email channel).

import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

const DEFAULT_FIRST_ORDER = [
  { isDefault: 'desc' as const },
  { createdAt: 'asc' as const },
]

export async function findPrimaryGmailMailbox(db: Db, agentId: string) {
  return db.gmailMailbox.findFirst({
    where: { agentId, deletedAt: null },
    orderBy: DEFAULT_FIRST_ORDER,
  })
}

export async function findPrimaryGmailMailboxSelect<
  T extends Prisma.GmailMailboxSelect,
>(db: Db, agentId: string, select: T) {
  return db.gmailMailbox.findFirst({
    where: { agentId, deletedAt: null },
    orderBy: DEFAULT_FIRST_ORDER,
    select,
  })
}

export async function listAgentGmailMailboxes(db: Db, agentId: string) {
  return db.gmailMailbox.findMany({
    where: { agentId, deletedAt: null },
    orderBy: DEFAULT_FIRST_ORDER,
  })
}
