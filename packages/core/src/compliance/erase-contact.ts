// GDPR right-to-erasure (Article 17) — permanent contact data erasure.
//
// We do NOT hard-delete the Contact row: several relations are onDelete
// Restrict/SetNull, so a raw delete would fail unpredictably or orphan data.
// Instead we perform the recognised, safe, PERMANENT method — crypto-shred +
// anonymise (a "tombstone"): the personal data is irreversibly destroyed
// (overwritten/nulled, encrypted fields' wrapped DEKs deleted, free-text
// interaction content redacted) while referential integrity is preserved. The
// data subject can no longer be identified, which is what Article 17 requires.
//
// This runs in a single transaction so a failure leaves the record untouched.
// It is idempotent: a second call on an already-erased contact is a no-op.
// CLAUDE.md §21 (crypto-shred on erasure), §3 (audited), §41.

import { type PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

export const ERASED_MARKER = '[erased]'

export interface EraseContactInput {
  contactId: string
  actorId: string | null
  requestId?: string
  /** Free-text reason recorded on the audit row (e.g. "DSAR erasure request"). */
  reason?: string
}

export interface EraseContactResult {
  erased: boolean
  alreadyErased: boolean
  interactionsRedacted: number
  encryptedFieldsShredded: number
  channelsDeleted: number
}

// Prisma transaction client. The models we touch are present on both the
// top-level client and a transaction client.
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

async function eraseWithinTx(tx: Tx, input: EraseContactInput): Promise<EraseContactResult> {
  const before = await tx.contact.findUnique({
    where: { id: input.contactId },
    select: { id: true, erasedAt: true },
  })
  if (!before) {
    throw new Error(`Contact ${input.contactId} not found`)
  }
  if (before.erasedAt) {
    return {
      erased: false,
      alreadyErased: true,
      interactionsRedacted: 0,
      encryptedFieldsShredded: 0,
      channelsDeleted: 0,
    }
  }

  const now = new Date()

  // 1. Overwrite / null every identifying field on the contact itself.
  await tx.contact.update({
    where: { id: input.contactId },
    data: {
      firstName: ERASED_MARKER,
      lastName: null,
      email: null,
      phoneE164: null,
      dateOfBirth: null,
      notes: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      postcode: null,
      country: null,
      schoolName: null,
      yearGroup: null,
      jobTitle: null,
      pronouns: null,
      mailchimpEmail: null,
      referralSource: null,
      examTarget: null,
      // Ensure it leaves every active view, and record the erasure.
      deletedAt: now,
      erasedAt: now,
      erasureScheduledAt: null,
      updatedById: input.actorId,
    },
  })

  // 2. Delete supplementary personal data attached to the contact — the extra
  //    points of contact (second emails/phones) and the booking guardian /
  //    bill-payer profile (guardian name/phone/email).
  const channels = await tx.contactChannel.deleteMany({ where: { contactId: input.contactId } })
  await tx.contactBookingProfile.deleteMany({ where: { contactId: input.contactId } })

  // 3. Crypto-shred: destroy the wrapped DEKs for any encrypted fields owned by
  //    this contact, so their ciphertext is permanently unrecoverable. The
  //    EncryptedField owner column is the legacy-named `contactId`.
  const shredded = await tx.encryptedField.deleteMany({ where: { contactId: input.contactId } })

  // 4. Redact the free-text content of the contact's timeline — message
  //    bodies, notes, call summaries all live in Interaction.summary/payload.
  const redacted = await tx.interaction.updateMany({
    where: { contactId: input.contactId },
    data: { summary: ERASED_MARKER, payload: {} },
  })

  // 5. Audit the erasure (append-only accountability record survives).
  await writeAuditLogEntry(tx, {
    actorId: input.actorId,
    action: 'contact.erased',
    target: { type: 'Contact', id: input.contactId },
    requestId: input.requestId,
    after: {
      reason: input.reason ?? null,
      interactionsRedacted: redacted.count,
      encryptedFieldsShredded: shredded.count,
      channelsDeleted: channels.count,
    },
  })

  return {
    erased: true,
    alreadyErased: false,
    interactionsRedacted: redacted.count,
    encryptedFieldsShredded: shredded.count,
    channelsDeleted: channels.count,
  }
}

/**
 * Permanently erase a contact's personal data (crypto-shred + anonymise),
 * atomically and idempotently. Callers gate authorisation (CEO / Senior
 * Manager) before invoking.
 */
export async function eraseContactData(
  db: PrismaClient,
  input: EraseContactInput,
): Promise<EraseContactResult> {
  return db.$transaction((tx) => eraseWithinTx(tx, input))
}
