// Shared actor context + Db type for task domain writers.

import type { Prisma, PrismaClient } from '@prisma/client'

/** Accepts both the top-level client and an interactive transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient

export interface ActorCtx {
  actorId: string
  requestId: string
}
