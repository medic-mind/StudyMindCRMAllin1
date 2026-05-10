// Nightly retention engine. CLAUDE.md §17.1, §21.
//
// Two passes:
//   1. soft-delete: rows older than the per-category retention get
//      softDeletedAt = now and pendingHardDeleteAt = now + 30 days.
//   2. hard-delete: rows whose pendingHardDeleteAt is in the past get
//      their S3 attachments deleted, any EncryptedField rows
//      crypto-shredded (DEK ciphertext replaced with a sentinel that
//      will fail AAD on decrypt), and the row itself hard-deleted.
//
// All work is batched (default 200) and idempotent: re-running in the
// same window does nothing because soft-delete rows already have
// softDeletedAt set, and hard-delete rows are gone after the first
// pass. The boundary calls these pure functions through Inngest steps.
//
// Audit: each batch writes one AuditLogEntry under the synthetic actor
// `system:compliance/enforce-retention` with the category and count.

import {
  HARD_DELETE_GRACE_DAYS,
  type RetentionCategory,
  softDeleteCutoff,
} from '@studymind/core/retention/policies'

export const RETENTION_BATCH_SIZE = 200

/** Sentinel inserted into EncryptedField.dekCiphertext on crypto-shred. */
export const CRYPTO_SHRED_PREFIX = 'CRYPTO_SHREDDED:' as const

export function cryptoShredSentinel(now: Date): string {
  return `${CRYPTO_SHRED_PREFIX}${now.toISOString()}`
}

// -----------------------------------------------------------------------------
// Categories → row identification
// -----------------------------------------------------------------------------

/** Interaction.type values that count as email retention rows. */
export const EMAIL_INTERACTION_TYPES = ['email', 'email_received', 'email_sent'] as const

/** Interaction.type values that count as call/recording rows. */
export const CALL_INTERACTION_TYPES = ['call'] as const

/** Interaction.type values that count as general notes. */
export const NOTE_INTERACTION_TYPES = ['note'] as const

// -----------------------------------------------------------------------------
// Minimal DB shape — keeps tests free of the full Prisma client
// -----------------------------------------------------------------------------

export interface InteractionRow {
  id: string
  type: string
  occurredAt: Date
  createdAt: Date
  payload: unknown
  softDeletedAt: Date | null
  pendingHardDeleteAt: Date | null
}

export interface LeadRow {
  id: string
  createdAt: Date
  convertedAt: Date | null
  softDeletedAt: Date | null
  pendingHardDeleteAt: Date | null
}

export interface EncryptedFieldRow {
  id: string
  contactId: string
  column: string
  dekCiphertext: Buffer | string
}

export interface RetentionDb {
  interaction: {
    findMany: (args: {
      where: Record<string, unknown>
      take: number
      select: Record<string, true>
    }) => Promise<InteractionRow[]>
    updateMany: (args: {
      where: { id: { in: string[] } }
      data: { softDeletedAt: Date; pendingHardDeleteAt: Date }
    }) => Promise<{ count: number }>
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<{ count: number }>
  }
  lead: {
    findMany: (args: {
      where: Record<string, unknown>
      take: number
      select: Record<string, true>
    }) => Promise<LeadRow[]>
    updateMany: (args: {
      where: { id: { in: string[] } }
      data: { softDeletedAt: Date; pendingHardDeleteAt: Date }
    }) => Promise<{ count: number }>
    deleteMany: (args: { where: { id: { in: string[] } } }) => Promise<{ count: number }>
  }
  encryptedField: {
    findMany: (args: {
      where: { contactId: string; column: { startsWith?: string } }
      select: Record<string, true>
    }) => Promise<EncryptedFieldRow[]>
    updateMany: (args: {
      where: { id: { in: string[] } }
      data: { dekCiphertext: Buffer | string }
    }) => Promise<{ count: number }>
  }
}

export interface S3Deleter {
  deleteObject: (s3Key: string) => Promise<void>
}

const NOOP_S3: S3Deleter = { deleteObject: async () => undefined }

export interface AuditWriter {
  write: (input: {
    actorId: string
    action: string
    targetType: string
    targetId: string
    after: unknown
  }) => Promise<void>
}

const NOOP_AUDIT: AuditWriter = { write: async () => undefined }

// -----------------------------------------------------------------------------
// Pass 1: soft-delete
// -----------------------------------------------------------------------------

export interface SoftDeleteResult {
  category: RetentionCategory
  softDeleted: number
}

/**
 * Find rows in this category older than the policy cutoff with
 * `softDeletedAt IS NULL`, mark them soft-deleted, and set the
 * `pendingHardDeleteAt` grace clock. Idempotent.
 */
export async function softDeleteCategory(
  db: RetentionDb,
  category: RetentionCategory,
  now: Date,
): Promise<SoftDeleteResult> {
  const cutoff = softDeleteCutoff(category, now)
  const grace = new Date(now.getTime())
  grace.setUTCDate(grace.getUTCDate() + HARD_DELETE_GRACE_DAYS)

  if (category === 'marketingLead') {
    const rows = await db.lead.findMany({
      where: {
        softDeletedAt: null,
        convertedAt: null,
        createdAt: { lt: cutoff },
      },
      take: RETENTION_BATCH_SIZE,
      select: { id: true },
    })
    if (rows.length === 0) return { category, softDeleted: 0 }
    const r = await db.lead.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { softDeletedAt: now, pendingHardDeleteAt: grace },
    })
    return { category, softDeleted: r.count }
  }

  // All other categories live on Interaction.
  const baseWhere: Record<string, unknown> = {
    softDeletedAt: null,
    occurredAt: { lt: cutoff },
  }
  if (category === 'email') {
    baseWhere['type'] = { in: [...EMAIL_INTERACTION_TYPES] }
  } else if (category === 'callRecording') {
    baseWhere['type'] = { in: [...CALL_INTERACTION_TYPES] }
    baseWhere['payload'] = { path: ['recordingS3Key'], not: null as unknown as undefined }
  } else if (category === 'callTranscript') {
    baseWhere['type'] = { in: [...CALL_INTERACTION_TYPES] }
    baseWhere['payload'] = { path: ['transcript'], not: null as unknown as undefined }
  } else if (category === 'generalNote') {
    baseWhere['type'] = { in: [...NOTE_INTERACTION_TYPES] }
  }

  const rows = await db.interaction.findMany({
    where: baseWhere,
    take: RETENTION_BATCH_SIZE,
    select: { id: true },
  })
  if (rows.length === 0) return { category, softDeleted: 0 }
  const r = await db.interaction.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { softDeletedAt: now, pendingHardDeleteAt: grace },
  })
  return { category, softDeleted: r.count }
}

// -----------------------------------------------------------------------------
// Pass 2: hard-delete
// -----------------------------------------------------------------------------

export interface HardDeleteResult {
  scope: 'interaction' | 'lead'
  hardDeleted: number
  s3Deletions: number
  cryptoShredded: number
}

interface InteractionPayloadShape {
  recordingS3Key?: string
  attachmentS3Keys?: string[]
  encryptedFieldKey?: string
  contactId?: string
}

function payloadOf(p: unknown): InteractionPayloadShape {
  if (!p || typeof p !== 'object') return {}
  return p as InteractionPayloadShape
}

/**
 * Hard-delete Interaction rows whose grace window has elapsed. For each:
 *   - delete S3 attachments (recordingS3Key, attachmentS3Keys[]) if any
 *   - if the payload references an EncryptedField (encryptedFieldKey +
 *     contactId), crypto-shred the DEK ciphertext on those rows
 *   - delete the row itself
 */
export async function hardDeleteInteractions(
  db: RetentionDb,
  now: Date,
  s3: S3Deleter = NOOP_S3,
): Promise<HardDeleteResult> {
  const rows = await db.interaction.findMany({
    where: { pendingHardDeleteAt: { lt: now } },
    take: RETENTION_BATCH_SIZE,
    select: {
      id: true,
      type: true,
      occurredAt: true,
      createdAt: true,
      payload: true,
      softDeletedAt: true,
      pendingHardDeleteAt: true,
    },
  })
  if (rows.length === 0) {
    return { scope: 'interaction', hardDeleted: 0, s3Deletions: 0, cryptoShredded: 0 }
  }

  let s3Deletions = 0
  let cryptoShredded = 0
  const sentinel = cryptoShredSentinel(now)

  for (const row of rows) {
    const p = payloadOf(row.payload)
    const keys: string[] = []
    if (p.recordingS3Key) keys.push(p.recordingS3Key)
    if (Array.isArray(p.attachmentS3Keys)) {
      for (const k of p.attachmentS3Keys) {
        if (typeof k === 'string') keys.push(k)
      }
    }
    for (const k of keys) {
      await s3.deleteObject(k)
      s3Deletions += 1
    }

    if (p.encryptedFieldKey && p.contactId) {
      const fields = await db.encryptedField.findMany({
        where: { contactId: p.contactId, column: { startsWith: p.encryptedFieldKey } },
        select: { id: true },
      })
      if (fields.length > 0) {
        const r = await db.encryptedField.updateMany({
          where: { id: { in: fields.map((f) => f.id) } },
          data: { dekCiphertext: sentinel },
        })
        cryptoShredded += r.count
      }
    }
  }

  const r = await db.interaction.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  })
  return {
    scope: 'interaction',
    hardDeleted: r.count,
    s3Deletions,
    cryptoShredded,
  }
}

/** Hard-delete Lead rows whose grace window has elapsed. No S3 / no DEKs. */
export async function hardDeleteLeads(db: RetentionDb, now: Date): Promise<HardDeleteResult> {
  const rows = await db.lead.findMany({
    where: { pendingHardDeleteAt: { lt: now } },
    take: RETENTION_BATCH_SIZE,
    select: { id: true },
  })
  if (rows.length === 0) {
    return { scope: 'lead', hardDeleted: 0, s3Deletions: 0, cryptoShredded: 0 }
  }
  const r = await db.lead.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })
  return { scope: 'lead', hardDeleted: r.count, s3Deletions: 0, cryptoShredded: 0 }
}

// -----------------------------------------------------------------------------
// Top-level orchestrator (called from the boundary Inngest function)
// -----------------------------------------------------------------------------

export interface EnforceRetentionResult {
  softDeleted: SoftDeleteResult[]
  hardDeleted: HardDeleteResult[]
}

export async function enforceRetentionOnce(
  db: RetentionDb,
  now: Date,
  s3: S3Deleter = NOOP_S3,
  audit: AuditWriter = NOOP_AUDIT,
): Promise<EnforceRetentionResult> {
  const softCategories: RetentionCategory[] = [
    'callRecording',
    'callTranscript',
    'email',
    'generalNote',
    'marketingLead',
  ]
  const softDeleted: SoftDeleteResult[] = []
  for (const cat of softCategories) {
    const res = await softDeleteCategory(db, cat, now)
    softDeleted.push(res)
    if (res.softDeleted > 0) {
      await audit.write({
        actorId: 'system:compliance/enforce-retention',
        action: 'compliance.retention.soft_delete_batch',
        targetType: cat,
        targetId: now.toISOString(),
        after: { count: res.softDeleted },
      })
    }
  }

  const hardDeleted: HardDeleteResult[] = []
  const ix = await hardDeleteInteractions(db, now, s3)
  hardDeleted.push(ix)
  if (ix.hardDeleted > 0) {
    await audit.write({
      actorId: 'system:compliance/enforce-retention',
      action: 'compliance.retention.hard_delete_batch',
      targetType: 'Interaction',
      targetId: now.toISOString(),
      after: {
        count: ix.hardDeleted,
        s3Deletions: ix.s3Deletions,
        cryptoShredded: ix.cryptoShredded,
      },
    })
  }
  const ld = await hardDeleteLeads(db, now)
  hardDeleted.push(ld)
  if (ld.hardDeleted > 0) {
    await audit.write({
      actorId: 'system:compliance/enforce-retention',
      action: 'compliance.retention.hard_delete_batch',
      targetType: 'Lead',
      targetId: now.toISOString(),
      after: { count: ld.hardDeleted },
    })
  }

  return { softDeleted, hardDeleted }
}

// Inngest wiring lives at the worker boundary so we keep the S3 + Prisma
// clients out of @studymind/jobs (mirrors audit-log-archive).
export const ENFORCE_RETENTION_FUNCTIONS: never[] = []
