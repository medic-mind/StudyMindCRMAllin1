// Audit log writer. Append-only. See CLAUDE.md Section 20 and 21.
// Every write that touches Contact, FinancialAccount, or safeguarding fields
// MUST go through writeAuditLogEntry.

import { Prisma, type PrismaClient } from '@prisma/client'

export interface AuditTarget {
  type: string
  id: string
}

export interface WriteAuditLogEntryInput {
  actorId: string | null
  action: string
  target: AuditTarget
  before?: unknown
  after?: unknown
  requestId?: string
  purpose?: string
}

// Prisma transaction client. Compatible with both `db.$transaction(async tx => ...)`
// and the top-level client. The fields we touch (auditLogEntry) are present on both.
export type DbClient = PrismaClient | Prisma.TransactionClient

function toJsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) return Prisma.JsonNull
  return value as Prisma.InputJsonValue
}

function newId(): string {
  // CLAUDE.md §19 mandates cuid2 long-term. We use crypto.randomUUID() until the
  // ADR adding @paralleldrive/cuid2 lands. The shape is opaque to callers.
  return crypto.randomUUID()
}

/**
 * Persist a single AuditLogEntry row. Returns the new row id.
 *
 * Idempotency: when `requestId` is supplied, repeating the same
 * (requestId, action, targetType, targetId) tuple is a no-op and returns the
 * existing row id. This protects retried Inngest steps from double-writes.
 */
export async function writeAuditLogEntry(
  db: DbClient,
  input: WriteAuditLogEntryInput,
): Promise<string> {
  const { actorId, action, target, before, after, requestId, purpose } = input

  if (requestId) {
    const existing = await db.auditLogEntry.findFirst({
      where: {
        requestId,
        action,
        targetType: target.type,
        targetId: target.id,
      },
      select: { id: true },
    })
    if (existing) return existing.id
  }

  const row = await db.auditLogEntry.create({
    data: {
      id: newId(),
      action,
      actorId: actorId ?? null,
      targetType: target.type,
      targetId: target.id,
      requestId: requestId ?? null,
      purpose: purpose ?? null,
      before: toJsonValue(before),
      after: toJsonValue(after),
    },
    select: { id: true },
  })
  return row.id
}

export interface WithAuditCtx {
  actorId: string | null
  requestId?: string
}

export interface AuditingTx {
  audit: (input: Omit<WriteAuditLogEntryInput, 'actorId' | 'requestId'>) => Promise<string>
}

/**
 * Run `fn` inside a Prisma transaction with an `audit()` helper bound to the
 * caller's actor id and request id. Audit rows land in the same transaction as
 * the domain writes, so a rollback discards both.
 */
export async function withAudit<T>(
  db: PrismaClient,
  ctx: WithAuditCtx,
  fn: (tx: Prisma.TransactionClient, helpers: AuditingTx) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const helpers: AuditingTx = {
      audit: (input) =>
        writeAuditLogEntry(tx, {
          ...input,
          actorId: ctx.actorId,
          requestId: ctx.requestId,
        }),
    }
    return fn(tx, helpers)
  })
}
