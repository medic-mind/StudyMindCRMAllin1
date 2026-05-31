// Shared actor context for chat domain writers (ADR 0022). Mirrors the board
// domain's ctx so the two read the same.

import type { Prisma, PrismaClient } from '@prisma/client'

/** Accepts both the top-level client and an interactive transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient

export interface ActorCtx {
  actorId: string
  requestId: string
}
