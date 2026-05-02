// ProviderEvent upsert. Idempotent on (provider, eventId).
// Webhook handlers call this BEFORE enqueueing async work — the row is the
// audit trail and replay log. CLAUDE.md §7.1, §8.

import type { Prisma, PrismaClient } from '@prisma/client'
import { createId } from '@paralleldrive/cuid2'

export type DbClient = PrismaClient | Prisma.TransactionClient

export interface UpsertProviderEventInput {
  provider: string
  eventId: string
  type: string
  raw: unknown
  receivedAt?: Date
}

export interface UpsertProviderEventResult {
  id: string
  created: boolean
}

/**
 * Upsert a ProviderEvent row. Returns `{ created: false }` on duplicate so the
 * caller can short-circuit a redundant Inngest enqueue. Provider deduping is
 * the contract for every webhook (Stripe, GoCardless, Aircall, ...).
 */
export async function upsertProviderEvent(
  db: DbClient,
  input: UpsertProviderEventInput,
): Promise<UpsertProviderEventResult> {
  const existing = await db.providerEvent.findUnique({
    where: {
      provider_eventId: { provider: input.provider, eventId: input.eventId },
    },
    select: { id: true },
  })
  if (existing) return { id: existing.id, created: false }

  // The race between findUnique and create is closed by the unique index;
  // if a concurrent insert wins, we treat the conflict as a no-op replay.
  try {
    const row = await db.providerEvent.create({
      data: {
        id: createId(),
        provider: input.provider,
        eventId: input.eventId,
        type: input.type,
        raw: input.raw as Prisma.InputJsonValue,
        receivedAt: input.receivedAt ?? new Date(),
      },
      select: { id: true },
    })
    return { id: row.id, created: true }
  } catch (err) {
    // Prisma unique-violation: another writer beat us. Re-read and return.
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      const row = await db.providerEvent.findUniqueOrThrow({
        where: {
          provider_eventId: { provider: input.provider, eventId: input.eventId },
        },
        select: { id: true },
      })
      return { id: row.id, created: false }
    }
    throw err
  }
}
