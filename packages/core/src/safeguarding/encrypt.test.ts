// Tests for encrypt + decrypt round-trip with mocked KMS. CLAUDE.md §21.1.

import { randomBytes } from 'node:crypto'

import { GenerateDataKeyCommand, KMSClient, DecryptCommand } from '@aws-sdk/client-kms'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encryptField } from './encrypt'
import { decryptField, decryptFieldById } from './decrypt'
import { setKmsClient } from './kms'

interface InMemRow {
  id: string
  contactId: string
  column: string
  ciphertext: Buffer
  iv: Buffer
  dekCiphertext: Buffer
  aad: Buffer
  keyVersion: number
}

interface InMemAudit {
  id: string
  action: string
  actorId: string | null
  targetType: string
  targetId: string
  requestId: string | null
  purpose: string | null
  before: unknown
  after: unknown
  createdAt: Date
}

function makeFakeDb() {
  const fields = new Map<string, InMemRow>()
  const audits: InMemAudit[] = []
  return {
    fields,
    audits,
    encryptedField: {
      upsert: vi.fn(async ({ where, create, update }: { where: { contactId_column: { contactId: string; column: string } }; create: InMemRow; update: Partial<InMemRow> }) => {
        const key = `${where.contactId_column.contactId}:${where.contactId_column.column}`
        const existing = fields.get(key)
        if (existing) {
          const merged: InMemRow = { ...existing, ...update }
          fields.set(key, merged)
          return merged
        }
        const row: InMemRow = { ...create }
        fields.set(key, row)
        return row
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        for (const row of fields.values()) if (row.id === where.id) return row
        throw new Error('not found')
      }),
    },
    auditLogEntry: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: InMemAudit }) => {
        audits.push(data)
        return { id: data.id }
      }),
    },
  }
}

const kmsMock = mockClient(KMSClient)

beforeEach(() => {
  process.env['AWS_KMS_KEY_ID'] = 'alias/crm-test'
  kmsMock.reset()
  // Single deterministic DEK for the test.
  const dek = randomBytes(32)
  kmsMock.on(GenerateDataKeyCommand).resolves({
    Plaintext: dek,
    CiphertextBlob: Buffer.from('dek-wrapped'),
    KeyId: 'alias/crm-test',
  })
  kmsMock.on(DecryptCommand).resolves({ Plaintext: dek })
  setKmsClient(new KMSClient({ region: 'eu-west-2' }))
})

afterEach(() => {
  setKmsClient(null)
  kmsMock.reset()
})

describe('encryptField + decryptField round-trip', () => {
  it('round-trips plaintext via KMS envelope', async () => {
    const db = makeFakeDb()
    const row = await encryptField(db as never, {
      ownerType: 'Contact',
      ownerId: 'contact-1',
      fieldName: 'safeguarding_body',
      plaintext: 'sensitive concern body',
      ctx: { actorId: 'user-1', requestId: 'req-1' },
    })

    expect(row.keyVersion).toBe(1)
    expect(row.ciphertext.length).toBeGreaterThan(16)
    expect(row.iv.length).toBe(12)

    const plaintext = await decryptField(
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        dekCiphertext: row.dekCiphertext,
        aad: row.aad,
        keyVersion: row.keyVersion,
      },
      { actorId: 'user-1', purpose: 'unit-test' },
    )
    expect(plaintext).toBe('sensitive concern body')
  })

  it('writes the encrypt audit row', async () => {
    const db = makeFakeDb()
    await encryptField(db as never, {
      ownerType: 'Contact',
      ownerId: 'contact-1',
      fieldName: 'safeguarding_body',
      plaintext: 'x',
      ctx: { actorId: 'user-1', requestId: 'req-A' },
    })
    expect(db.audits).toHaveLength(1)
    expect(db.audits[0]?.action).toBe('safeguarding.field_encrypted')
  })

  it('AAD mismatch fails closed', async () => {
    const db = makeFakeDb()
    const row = await encryptField(db as never, {
      ownerType: 'Contact',
      ownerId: 'contact-1',
      fieldName: 'safeguarding_body',
      plaintext: 'sensitive',
      ctx: { actorId: 'user-1' },
    })
    const tamperedAad = Buffer.from('Contact|other-contact|safeguarding_body|1')
    await expect(
      decryptField(
        {
          ciphertext: row.ciphertext,
          iv: row.iv,
          dekCiphertext: row.dekCiphertext,
          aad: tamperedAad,
          keyVersion: row.keyVersion,
        },
        { actorId: 'user-1', purpose: 'unit-test' },
      ),
    ).rejects.toThrow(/authentication failed|envelope/)
  })

  it('empty purpose is rejected', async () => {
    const db = makeFakeDb()
    const row = await encryptField(db as never, {
      ownerType: 'Contact',
      ownerId: 'contact-1',
      fieldName: 'f',
      plaintext: 'x',
      ctx: { actorId: 'user-1' },
    })
    await expect(
      decryptField(
        {
          ciphertext: row.ciphertext,
          iv: row.iv,
          dekCiphertext: row.dekCiphertext,
          aad: row.aad,
          keyVersion: row.keyVersion,
        },
        { actorId: 'user-1', purpose: '' },
      ),
    ).rejects.toThrow(/purpose/)
  })
})

describe('decryptFieldById', () => {
  it('writes the decrypt audit row BEFORE returning plaintext', async () => {
    const db = makeFakeDb()
    const row = await encryptField(db as never, {
      ownerType: 'Contact',
      ownerId: 'contact-1',
      fieldName: 'safeguarding_body',
      plaintext: 'top secret',
      ctx: { actorId: 'user-1' },
    })
    db.audits.length = 0 // reset to inspect just the decrypt audit

    const plaintext = await decryptFieldById(db as never, {
      encryptedFieldId: row.id,
      actorId: 'user-2',
      purpose: 'safeguarding triage',
      requestId: 'req-D',
    })

    expect(plaintext).toBe('top secret')
    // The audit row must have been written before plaintext was returned.
    expect(db.audits).toHaveLength(1)
    expect(db.audits[0]?.action).toBe('safeguarding.field_decrypted')
    expect(db.audits[0]?.purpose).toBe('safeguarding triage')
  })

  it('rejects empty purpose at the schema layer', async () => {
    const db = makeFakeDb()
    const row = await encryptField(db as never, {
      ownerType: 'Contact',
      ownerId: 'contact-1',
      fieldName: 'safeguarding_body',
      plaintext: 'x',
      ctx: { actorId: 'user-1' },
    })
    await expect(
      decryptFieldById(db as never, {
        encryptedFieldId: row.id,
        actorId: 'user-2',
        purpose: '',
      }),
    ).rejects.toThrow(/purpose/)
  })

  it('break-glass path writes a safeguarding.break_glass audit and invokes the reporter without plaintext', async () => {
    const db = makeFakeDb()
    const row = await encryptField(db as never, {
      ownerType: 'Contact',
      ownerId: 'contact-1',
      fieldName: 'safeguarding_body',
      plaintext: 'classified',
      ctx: { actorId: 'dsl-1' },
    })
    db.audits.length = 0

    const reportedAlerts: unknown[] = []
    const plaintext = await decryptFieldById(db as never, {
      encryptedFieldId: row.id,
      actorId: 'admin-99',
      purpose: 'urgent triage',
      requestId: 'req-BG',
      breakGlass: {
        isBreakGlass: true,
        actorRoles: ['admin'],
        assignedDslUserId: 'dsl-1',
      },
      breakGlassReporter: async (alert) => {
        reportedAlerts.push(alert)
      },
    })

    expect(plaintext).toBe('classified')
    expect(db.audits).toHaveLength(2)
    expect(db.audits[0]?.action).toBe('safeguarding.field_decrypted')
    expect(db.audits[1]?.action).toBe('safeguarding.break_glass')
    expect((db.audits[1]?.after as Record<string, unknown>).assignedDslUserId).toBe('dsl-1')
    expect((db.audits[1]?.after as Record<string, unknown>).kmsCallId).toBeDefined()

    expect(reportedAlerts).toHaveLength(1)
    const alert = reportedAlerts[0] as Record<string, unknown>
    expect(alert.actorId).toBe('admin-99')
    expect(alert.assignedDslUserId).toBe('dsl-1')
    expect(alert.kmsCallId).toBeDefined()
    // No plaintext fields in the alert.
    expect(JSON.stringify(alert)).not.toContain('classified')
  })

  it('non-break-glass DSL access does not write break_glass audit and does not invoke the reporter', async () => {
    const db = makeFakeDb()
    const row = await encryptField(db as never, {
      ownerType: 'Contact',
      ownerId: 'contact-1',
      fieldName: 'safeguarding_body',
      plaintext: 'normal',
      ctx: { actorId: 'dsl-1' },
    })
    db.audits.length = 0

    let called = 0
    const plaintext = await decryptFieldById(db as never, {
      encryptedFieldId: row.id,
      actorId: 'dsl-1',
      purpose: 'standard read',
      breakGlass: { isBreakGlass: false, actorRoles: ['dsl'] },
      breakGlassReporter: async () => {
        called++
      },
    })
    expect(plaintext).toBe('normal')
    expect(db.audits).toHaveLength(1)
    expect(db.audits[0]?.action).toBe('safeguarding.field_decrypted')
    expect(called).toBe(0)
  })
})

describe('local-key fallback (no KMS configured)', () => {
  beforeEach(() => {
    // Parent beforeEach set AWS_KMS_KEY_ID + a mock client; undo both so the
    // local backend is exercised and any stray KMS call would be obvious.
    delete process.env['AWS_KMS_KEY_ID']
    setKmsClient(null)
    process.env['CRM_LOCAL_ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64')
  })

  afterEach(() => {
    delete process.env['CRM_LOCAL_ENCRYPTION_KEY']
    delete process.env['AUTH_SECRET']
  })

  it('round-trips plaintext via an explicit local AES master key', async () => {
    const db = makeFakeDb()
    const row = await encryptField(db as never, {
      ownerType: 'TrengoToken',
      ownerId: 'agent-1',
      fieldName: 'trengo.api_token',
      plaintext: 'tok_local_secret',
      ctx: { actorId: 'agent-1', requestId: 'req-L' },
    })

    // Locally-wrapped DEKs carry the sentinel prefix; KMS blobs never do.
    expect(row.dekCiphertext.subarray(0, 8).toString('utf8')).toBe('SMxLOCAL')

    const plaintext = await decryptField(
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        dekCiphertext: row.dekCiphertext,
        aad: row.aad,
        keyVersion: row.keyVersion,
      },
      { actorId: 'agent-1', purpose: 'unit-test' },
    )
    expect(plaintext).toBe('tok_local_secret')
  })

  it('derives the key from AUTH_SECRET when no explicit local key is set', async () => {
    delete process.env['CRM_LOCAL_ENCRYPTION_KEY']
    process.env['AUTH_SECRET'] = 'stable-test-auth-secret'

    const db = makeFakeDb()
    const row = await encryptField(db as never, {
      ownerType: 'TrengoToken',
      ownerId: 'agent-2',
      fieldName: 'trengo.api_token',
      plaintext: 'tok_derived',
      ctx: { actorId: 'agent-2' },
    })
    const plaintext = await decryptField(
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        dekCiphertext: row.dekCiphertext,
        aad: row.aad,
        keyVersion: row.keyVersion,
      },
      { actorId: 'agent-2', purpose: 'unit-test' },
    )
    expect(plaintext).toBe('tok_derived')
  })
})
