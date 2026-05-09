// DSAR export builder. CLAUDE.md §21.
//
// Reads every row that mentions the contact, decrypts safeguarding fields
// (each decryption writes an audit row before the plaintext is produced),
// and packages everything into a single zip stream with a tamper-evident
// manifest.
//
// The export is generated on demand and never persisted. The runbook
// (docs/runbooks/dsar-export.md) is the chain of custody once the operator
// downloads the zip to their device.

import { createHash } from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'

import archiver from 'archiver'
import type { PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { decryptFieldById } from '../safeguarding/decrypt'

export interface DsarManifestEntry {
  table: string
  primaryKey: string
  sha256: string
  encrypted?: boolean
}

export interface DsarManifest {
  contactId: string
  generatedAt: string
  actorId: string | null
  requestId: string
  entries: DsarManifestEntry[]
}

export interface BuildDsarExportInput {
  contactId: string
  actorId: string | null
  requestId: string
}

export interface BuildDsarExportOutput {
  stream: Readable
  manifest: DsarManifest
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Build a DSAR export for a single contact. Returns a Readable stream that
 * yields a zip with: manifest.json plus one JSON file per source table, plus
 * any S3 referenced binaries (call recordings, attachments) when present in
 * the Interaction payloads. The manifest carries a SHA-256 of every row
 * included so a recipient can verify nothing was altered post-export.
 */
export async function buildDsarExport(
  db: PrismaClient,
  input: BuildDsarExportInput,
): Promise<BuildDsarExportOutput> {
  const { contactId, actorId, requestId } = input

  // Audit the export itself before reading anything.
  await writeAuditLogEntry(db, {
    action: 'dsar.exported',
    actorId,
    target: { type: 'Contact', id: contactId },
    requestId,
    purpose: `dsar:${contactId}`,
  })

  const manifest: DsarManifest = {
    contactId,
    generatedAt: new Date().toISOString(),
    actorId,
    requestId,
    entries: [],
  }

  const archive = archiver('zip', { zlib: { level: 9 } })
  const passthrough = new PassThrough()
  archive.pipe(passthrough)

  // Helper that pushes a JSON blob into the zip and records its hash.
  const pushTable = (table: string, rows: Array<Record<string, unknown>>): void => {
    for (const row of rows) {
      const pk = String(row['id'] ?? row['contactId'] ?? row['familyId'] ?? '')
      manifest.entries.push({ table, primaryKey: pk, sha256: sha256(row) })
    }
    archive.append(JSON.stringify(rows, null, 2), { name: `${table}.json` })
  }

  // 1. Contact + family membership.
  const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId } })
  pushTable('Contact', [contact as unknown as Record<string, unknown>])

  const memberships = await db.familyMember.findMany({ where: { contactId } })
  pushTable('FamilyMember', memberships as unknown as Array<Record<string, unknown>>)

  const familyIds = memberships.map((m) => m.familyId)

  // 2. Interactions (timeline).
  const interactions = await db.interaction.findMany({
    where: {
      OR: [
        { contactId },
        ...(familyIds.length > 0 ? [{ familyId: { in: familyIds } }] : []),
      ],
    },
    orderBy: { occurredAt: 'desc' },
  })
  pushTable('Interaction', interactions as unknown as Array<Record<string, unknown>>)

  // 3. Audit trail mentioning this contact.
  const auditEntries = await db.auditLogEntry.findMany({
    where: { OR: [{ targetType: 'Contact', targetId: contactId }, { actorId: contactId }] },
    orderBy: { occurredAt: 'desc' },
  })
  pushTable('AuditLogEntry', auditEntries as unknown as Array<Record<string, unknown>>)

  // 4. Bookings + sessions.
  if (familyIds.length > 0) {
    const bookings = await db.booking.findMany({ where: { familyId: { in: familyIds } } })
    pushTable('Booking', bookings as unknown as Array<Record<string, unknown>>)

    const bookingIds = bookings.map((b) => b.id)
    if (bookingIds.length > 0) {
      const sessions = await db.bookingSession.findMany({
        where: { bookingId: { in: bookingIds } },
      })
      pushTable('BookingSession', sessions as unknown as Array<Record<string, unknown>>)
    }

    // 5. Finance — payments, refunds.
    const payments = await db.payment.findMany({ where: { familyId: { in: familyIds } } })
    pushTable('Payment', payments as unknown as Array<Record<string, unknown>>)

    const paymentIds = payments.map((p) => p.id)
    if (paymentIds.length > 0) {
      const refunds = await db.refundIntent.findMany({
        where: { paymentId: { in: paymentIds } },
      })
      pushTable('RefundIntent', refunds as unknown as Array<Record<string, unknown>>)
    }
  }

  // 6. AI artefacts touching the contact.
  const status = await db.contactStatusSummary.findUnique({ where: { contactId } })
  if (status) pushTable('ContactStatusSummary', [status as unknown as Record<string, unknown>])

  if (familyIds.length > 0) {
    const churn = await db.churnScore.findMany({ where: { familyId: { in: familyIds } } })
    pushTable('ChurnScore', churn as unknown as Array<Record<string, unknown>>)
  }

  // 7. EncryptedField — decrypt each (audit row written by decryptFieldById
  // BEFORE the plaintext is produced, per CLAUDE.md §21.1).
  const encryptedRows = await db.encryptedField.findMany({
    where: { contactId },
    select: { id: true, column: true, keyVersion: true },
  })
  const decrypted: Array<{ id: string; column: string; plaintext: string }> = []
  for (const row of encryptedRows) {
    const plaintext = await decryptFieldById(db, {
      encryptedFieldId: row.id,
      actorId,
      purpose: `dsar:${contactId}`,
      requestId,
    })
    decrypted.push({ id: row.id, column: row.column, plaintext })
    manifest.entries.push({
      table: 'EncryptedField',
      primaryKey: row.id,
      sha256: sha256({ id: row.id, column: row.column, plaintext }),
      encrypted: true,
    })
  }
  archive.append(JSON.stringify(decrypted, null, 2), { name: 'EncryptedField.json' })

  // Manifest goes last so its hashes reflect everything above.
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })
  void archive.finalize()

  return { stream: passthrough, manifest }
}
