// Prisma client singleton.
// Re-export the generated client. We avoid creating multiple instances in dev.

import { PrismaClient } from '@prisma/client'

declare global {

  var __studymindPrisma: PrismaClient | undefined
}

export const db: PrismaClient =
  globalThis.__studymindPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalThis.__studymindPrisma = db
}

export * from '@prisma/client'
