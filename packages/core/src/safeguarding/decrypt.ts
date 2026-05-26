// Field-level decryption. CLAUDE.md §21.1.
//
// Production path: KMS Decrypt + AES-256-GCM with AAD verification.
//
//   1. Caller's role + per-row attribute check is the responsibility of the
//      tRPC procedure / domain function calling decryptField. The Zod policy
//      below enforces a non-empty `purpose`, which keeps audit honest.
//   2. AuditLogEntry is written BEFORE any decryption (CLAUDE.md §21.1).
//   3. KMS.Decrypt unwraps the DEK; AAD binds the field to its owner row, so
//      a swapped envelope fails closed at the GCM auth-tag check.
//   4. Plaintext is returned to the caller. Never logged.

import { createDecipheriv } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'
import { unwrapDataKey } from './envelope'

export type DbReader = PrismaClient | Prisma.TransactionClient

export interface EnvelopeCiphertext {
  ciphertext: Uint8Array
  iv: Uint8Array
  dekCiphertext: Uint8Array
  aad: Uint8Array
  keyVersion: number
}

export const DecryptContextSchema = z.object({
  actorId: z.string().min(1).nullable(),
  // Empty purpose is a hard fail — see CLAUDE.md §41.3 invariant.
  purpose: z.string().min(1, 'decryptField requires a non-empty purpose'),
  requestId: z.string().optional(),
})

export type DecryptContext = z.infer<typeof DecryptContextSchema>

/**
 * Decrypt a raw envelope. Used by callers that already have the bytes loaded
 * (e.g. Trengo per-agent token cache). Audit is the caller's responsibility
 * here because the caller knows the owning entity and purpose; this overload
 * does NOT write an audit row by itself. Use `decryptField` (below) for the
 * audited path that loads from EncryptedField by id.
 */
export async function decryptField(
  envelope: EnvelopeCiphertext,
  ctx: DecryptContext,
): Promise<string> {
  const parsed = DecryptContextSchema.safeParse(ctx)
  if (!parsed.success) {
    throw new BusinessError(
      'CONTACT_RESTRICTED',
      parsed.error.issues[0]?.message ?? 'invalid decrypt context',
    )
  }
  if (envelope.keyVersion === 0) {
    // Legacy dev/seed path. Only valid when no real KMS material has been
    // generated yet (e.g. seed scripts pre-Slice 6). Production rows are
    // keyVersion >= 1.
    return Buffer.from(envelope.ciphertext).toString('utf8')
  }

  return runEnvelopeDecrypt(envelope)
}

async function runEnvelopeDecrypt(envelope: EnvelopeCiphertext): Promise<string> {
  // Unwrap the DEK via whichever backend wrapped it (KMS or local key). AAD is
  // kept inside the GCM tag below so a tampered AAD also fails closed locally.
  let dekPlain: Buffer
  try {
    dekPlain = await unwrapDataKey(envelope.dekCiphertext)
  } catch {
    throw new BusinessError('CONTACT_RESTRICTED', 'failed to unwrap data key')
  }

  // The encrypt path appends the GCM auth tag to ciphertext.
  const cBuf = Buffer.from(envelope.ciphertext)
  if (cBuf.length < 16) {
    throw new BusinessError('CONTACT_RESTRICTED', 'ciphertext too short to contain GCM tag')
  }
  const ct = cBuf.subarray(0, cBuf.length - 16)
  const tag = cBuf.subarray(cBuf.length - 16)

  const decipher = createDecipheriv('aes-256-gcm', dekPlain, Buffer.from(envelope.iv))
  decipher.setAuthTag(tag)
  decipher.setAAD(Buffer.from(envelope.aad))

  let plaintext: string
  try {
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    // GCM auth failure — AAD or ciphertext was tampered with. Fail closed.
    dekPlain.fill(0)
    throw new BusinessError('CONTACT_RESTRICTED', 'envelope authentication failed')
  } finally {
    dekPlain.fill(0)
  }

  return plaintext
}

export interface DecryptByIdInput {
  encryptedFieldId: string
  actorId: string | null
  purpose: string
  requestId?: string
  /**
   * Break-glass metadata. Pass this when the caller has the `admin` role and
   * is not the assigned DSL for the EncryptedField's owning Contact. The
   * caller resolves "is admin" and "is assigned DSL" from RBAC + safeguarding
   * flags; here we just record + dispatch.
   *
   * When `isBreakGlass === true`, decryptFieldById writes an additional
   * `safeguarding.break_glass` audit entry and invokes the optional
   * `breakGlassReporter` callback. Plaintext is NEVER passed to the reporter
   * — only metadata. CLAUDE.md §21.1.
   */
  breakGlass?: {
    isBreakGlass: boolean
    /** Names of roles the actor holds (for the audit row). */
    actorRoles?: readonly string[]
    /** Optional id of the assigned DSL we expected, for context. */
    assignedDslUserId?: string | null
  }
  /**
   * Optional dispatcher for break-glass alerts (Slack, PagerDuty, Resend).
   * Injection avoids a core ↔ integrations cycle; the worker boundary wires
   * up the real implementation. When omitted, audit is still written.
   */
  breakGlassReporter?: BreakGlassReporter
}

export interface BreakGlassAlert {
  encryptedFieldId: string
  contactId: string
  column: string
  actorId: string | null
  actorRoles: readonly string[]
  assignedDslUserId: string | null
  purpose: string
  requestId: string | null
  kmsCallId: string
  occurredAt: Date
}

export type BreakGlassReporter = (alert: BreakGlassAlert) => Promise<void>

/**
 * Audited decrypt: looks up the EncryptedField row, writes an
 * AuditLogEntry BEFORE any decryption, then performs KMS-backed decrypt.
 */
export async function decryptFieldById(
  db: DbReader,
  input: DecryptByIdInput,
): Promise<string> {
  const ctx = DecryptContextSchema.parse({
    actorId: input.actorId,
    purpose: input.purpose,
    requestId: input.requestId,
  })

  const row = await db.encryptedField.findUniqueOrThrow({
    where: { id: input.encryptedFieldId },
    select: {
      id: true,
      contactId: true,
      column: true,
      ciphertext: true,
      iv: true,
      dekCiphertext: true,
      aad: true,
      keyVersion: true,
    },
  })

  // Audit BEFORE decryption — non-negotiable per CLAUDE.md §21.1.
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'safeguarding.field_decrypted',
    target: { type: 'EncryptedField', id: row.id },
    requestId: ctx.requestId,
    purpose: ctx.purpose,
    after: {
      contactId: row.contactId,
      column: row.column,
      keyVersion: row.keyVersion,
    },
  })

  // Break-glass: an additional audit entry plus a fan-out to alert sinks.
  // The plaintext is never passed to the reporter — only metadata.
  // CLAUDE.md §21.1.
  if (input.breakGlass?.isBreakGlass) {
    const occurredAt = new Date()
    const kmsCallId = `kms:${row.id}:${occurredAt.getTime()}`
    await writeAuditLogEntry(db, {
      actorId: ctx.actorId,
      action: 'safeguarding.break_glass',
      target: { type: 'EncryptedField', id: row.id },
      requestId: ctx.requestId,
      purpose: ctx.purpose,
      after: {
        contactId: row.contactId,
        column: row.column,
        keyVersion: row.keyVersion,
        actorRoles: input.breakGlass.actorRoles ?? [],
        assignedDslUserId: input.breakGlass.assignedDslUserId ?? null,
        kmsCallId,
      },
    })
    if (input.breakGlassReporter) {
      await input.breakGlassReporter({
        encryptedFieldId: row.id,
        contactId: row.contactId,
        column: row.column,
        actorId: ctx.actorId,
        actorRoles: input.breakGlass.actorRoles ?? [],
        assignedDslUserId: input.breakGlass.assignedDslUserId ?? null,
        purpose: ctx.purpose,
        requestId: ctx.requestId ?? null,
        kmsCallId,
        occurredAt,
      })
    }
  }

  return decryptField(
    {
      ciphertext: row.ciphertext,
      iv: row.iv,
      dekCiphertext: row.dekCiphertext,
      aad: row.aad,
      keyVersion: row.keyVersion,
    },
    ctx,
  )
}
