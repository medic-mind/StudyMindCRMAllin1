// Shared actor context for board domain writers (ADR 0018).

import type { Prisma, PrismaClient } from '@prisma/client'

/** Accepts both the top-level client and an interactive transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient

export interface ActorCtx {
  actorId: string
  requestId: string
}
