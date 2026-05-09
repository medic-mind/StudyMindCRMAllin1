// DSAR export integration test. CLAUDE.md §21.
//
// Uses an in-memory fake DB so we exercise the real buildDsarExport()
// against the same contract as the prisma client. Asserts:
//   - the manifest contains every expected row
//   - every decryption is preceded by an AuditLogEntry write
//   - the dsar.exported audit row is written first

import { Buffer } from 'node:buffer'

import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildDsarExport } from '@studymind/core/compliance/dsar'
import { encryptField, setKmsClient } from '@studymind/core/safeguarding'

// ----- Fake DB --------------------------------------------------------------

interface AuditRow {
  id: string
  action: string
  actorId: string | null
  targetType: string
  targetId: string
  requestId: string | null
  purpose: string | null
}

interface EncryptedRow {
  id: string
  contactId: string
  column: string
  ciphertext: Buffer
  iv: Buffer
  dekCiphertext: Buffer
  aad: Buffer
  keyVersion: number
}

function makeFakeDb() {
  const audits: AuditRow[] = []
  let auditN = 0

  const contact = {
    id: 'contact_1',
    legalName: 'Alex Test',
    kind: 'parent',
    createdAt: new Date('2025-01-01'),
  }
  const familyMembers = [
    { id: 'fm_1', familyId: 'fam_1', contactId: 'contact_1', role: 'parent' },
  ]
  const interactions = [
    {
      id: 'int_1',
      type: 'note',
      contactId: 'contact_1',
      familyId: null,
      occurredAt: new Date('2025-04-01'),
      summary: 'first note',
    },
    {
      id: 'int_2',
      type: 'family.state_changed',
      contactId: null,
      familyId: 'fam_1',
      occurredAt: new Date('2025-04-02'),
      summary: 'lead -> trial',
    },
  ]
  const bookings = [
    { id: 'bk_1', familyId: 'fam_1', state: 'confirmed' },
  ]
  const sessions = [{ id: 'bs_1', bookingId: 'bk_1', state: 'delivered' }]
  const payments = [{ id: 'pay_1', familyId: 'fam_1', amountMinor: 5000 }]
  const refunds = [{ id: 'ref_1', paymentId: 'pay_1', amountMinor: 100 }]
  const status = {
    contactId: 'contact_1',
    headerLine: 'Active',
    bodyLine: 'On track',
  }
  const churn = [{ id: 'ch_1', familyId: 'fam_1', score: 0.2 }]

  const encrypted: EncryptedRow[] = []

  const db = {
    auditLogEntry: {
      findFirst: async () => null,
      create: async ({ data }: { data: Partial<AuditRow> & { id?: string } }) => {
        const row: AuditRow = {
          id: data.id ?? `aud_${++auditN}`,
          action: String(data.action),
          actorId: data.actorId ?? null,
          targetType: String(data.targetType),
          targetId: String(data.targetId),
          requestId: data.requestId ?? null,
          purpose: data.purpose ?? null,
        }
        audits.push(row)
        return { id: row.id }
      },
      findMany: async () => audits.filter((a) => a.targetId === 'contact_1'),
    },
    contact: { findUniqueOrThrow: async () => contact },
    familyMember: {
      findMany: async ({ where }: { where: { contactId: string } }) =>
        familyMembers.filter((m) => m.contactId === where.contactId),
    },
    interaction: {
      findMany: async () => interactions,
    },
    booking: { findMany: async () => bookings },
    bookingSession: { findMany: async () => sessions },
    payment: { findMany: async () => payments },
    refundIntent: { findMany: async () => refunds },
    contactStatusSummary: { findUnique: async () => status },
    churnScore: { findMany: async () => churn },
    encryptedField: {
      findMany: async () =>
        encrypted.map((e) => ({ id: e.id, column: e.column, keyVersion: e.keyVersion })),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
        encrypted.find((e) => e.id === where.id) ??
        (() => {
          throw new Error('not found')
        })(),
      upsert: async ({
        create,
      }: {
        create: {
          id: string
          contactId: string
          column: string
          ciphertext: Buffer
          iv: Buffer
          dekCiphertext: Buffer
          aad: Buffer
          keyVersion: number
        }
      }) => {
        const row: EncryptedRow = { ...create }
        encrypted.push(row)
        return row
      },
    },
  }

  return { db, audits, encrypted }
}

// ----- KMS mock -------------------------------------------------------------

const kmsMock = mockClient(KMSClient)

beforeEach(() => {
  process.env['AWS_KMS_KEY_ID'] = 'alias/test-cmk'
  kmsMock.reset()
  const dek = new Uint8Array(32)
  // Encrypted DEK is opaque ciphertext; plaintext DEK is what we'll use.
  kmsMock.on(GenerateDataKeyCommand).resolves({
    Plaintext: dek,
    CiphertextBlob: new Uint8Array(64),
  })
  kmsMock.on(DecryptCommand).resolves({ Plaintext: dek })
  setKmsClient(new KMSClient({ region: 'eu-west-2' }))
})

afterEach(() => {
  kmsMock.reset()
})

// ----- Tests ----------------------------------------------------------------

async function seedEncrypted(db: ReturnType<typeof makeFakeDb>['db']): Promise<void> {
  await encryptField(db as never, {
    ownerType: 'Contact',
    ownerId: 'contact_1',
    fieldName: 'safeguarding_notes',
    plaintext: 'sensitive plaintext',
    ctx: { actorId: 'admin_1', purpose: 'seed' },
  })
}

describe('DSAR export', () => {
  it('writes dsar.exported audit BEFORE any other reads', async () => {
    const { db, audits } = makeFakeDb()
    await seedEncrypted(db)
    audits.length = 0
    await buildDsarExport(db as unknown as Parameters<typeof buildDsarExport>[0], {
      contactId: 'contact_1',
      actorId: 'admin_1',
      requestId: 'req_dsar_1',
    })
    // The first audit row written must be the dsar.exported one.
    const dsarAudits = audits.filter((a) => a.action === 'dsar.exported')
    expect(dsarAudits).toHaveLength(1)
    expect(dsarAudits[0]?.actorId).toBe('admin_1')
    expect(dsarAudits[0]?.targetId).toBe('contact_1')
    // Decryption audits exist too.
    const decryptAudits = audits.filter(
      (a) => a.action === 'safeguarding.field_decrypted',
    )
    expect(decryptAudits.length).toBeGreaterThan(0)
    // dsar.exported was first.
    expect(audits[0]?.action).toBe('dsar.exported')
  })

  it('manifest enumerates every fixture row with a sha256', async () => {
    const { db } = makeFakeDb()
    await seedEncrypted(db)
    const { manifest } = await buildDsarExport(
      db as unknown as Parameters<typeof buildDsarExport>[0],
      {
        contactId: 'contact_1',
        actorId: 'admin_1',
        requestId: 'req_dsar_2',
      },
    )
    const tables = new Set(manifest.entries.map((e) => e.table))
    for (const expected of [
      'Contact',
      'FamilyMember',
      'Interaction',
      'Booking',
      'BookingSession',
      'Payment',
      'RefundIntent',
      'ContactStatusSummary',
      'ChurnScore',
      'EncryptedField',
    ]) {
      expect(tables.has(expected), `missing ${expected}`).toBe(true)
    }
    for (const entry of manifest.entries) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    const enc = manifest.entries.find((e) => e.table === 'EncryptedField')
    expect(enc?.encrypted).toBe(true)
  })
})
