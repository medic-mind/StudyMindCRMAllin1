// Slice 6 safeguarding flow: raise → triage → escalate.
// Mock-DB integration test covering the contract between domain functions
// and the AI guard. CLAUDE.md §42.

import { randomBytes } from 'node:crypto'

import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  raiseConcern,
  recordLaReferral,
  setKmsClient,
  triageAction,
} from '@studymind/core/safeguarding'
import { setRestrictedGuardDb } from '@studymind/ai'
import { runStructured } from '@studymind/ai'

import { z } from 'zod'

// ----- Fake DB -----------------------------------------------------------------

interface InMemEncrypted {
  id: string
  contactId: string
  column: string
  ciphertext: Buffer
  iv: Buffer
  dekCiphertext: Buffer
  aad: Buffer
  keyVersion: number
}

interface InMemFlag {
  id: string
  contactId: string
  state: 'concern_logged' | 'restricted_access' | 'none'
  urgency: 'routine' | 'urgent' | 'immediate'
  dslUserId: string | null
  raisedById: string | null
  closedAt: Date | null
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
  createdById: string | null
  updatedById: string | null
}

interface InMemInteraction {
  id: string
  type: string
  contactId: string | null
  familyId: string | null
  occurredAt: Date
  summary: string | null
  payload: unknown
  createdAt: Date
  createdById: string | null
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
}

function makeFakeDb() {
  const flags = new Map<string, InMemFlag>()
  const fields = new Map<string, InMemEncrypted>()
  const interactions: InMemInteraction[] = []
  const audits: InMemAudit[] = []
  let n = 0
  const id = () => `id-${++n}`

  const db = {
    safeguardingFlag: {
      create: async ({ data }: { data: Partial<InMemFlag> & { id: string } }) => {
        const row: InMemFlag = {
          id: data.id,
          contactId: data.contactId!,
          state: (data.state as InMemFlag['state']) ?? 'concern_logged',
          urgency: (data.urgency as InMemFlag['urgency']) ?? 'routine',
          dslUserId: data.dslUserId ?? null,
          raisedById: data.raisedById ?? null,
          closedAt: null,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdById: data.createdById ?? null,
          updatedById: data.updatedById ?? null,
        }
        flags.set(row.id, row)
        return row
      },
      findUniqueOrThrow: async ({ where, select }: { where: { id: string }; select?: unknown }) => {
        const row = flags.get(where.id)
        if (!row) throw new Error('not found')
        void select
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<InMemFlag> }) => {
        const row = flags.get(where.id)
        if (!row) throw new Error('not found')
        Object.assign(row, data)
        return row
      },
      findMany: async ({ where }: { where: { contactId?: string; state?: string; deletedAt?: null } }) => {
        return Array.from(flags.values()).filter((f) => {
          if (where.contactId && f.contactId !== where.contactId) return false
          if (where.state && f.state !== where.state) return false
          if (where.deletedAt === null && f.deletedAt !== null) return false
          return true
        })
      },
      findFirst: async ({ where }: { where: { contactId: string; deletedAt: null; state: string } }) => {
        return (
          Array.from(flags.values()).find(
            (f) =>
              f.contactId === where.contactId &&
              f.state === where.state &&
              f.deletedAt === null,
          ) ?? null
        )
      },
    },
    encryptedField: {
      upsert: async ({ where, create, update }: { where: { contactId_column: { contactId: string; column: string } }; create: InMemEncrypted; update: Partial<InMemEncrypted> }) => {
        const k = `${where.contactId_column.contactId}:${where.contactId_column.column}`
        const existing = fields.get(k)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { ...create }
        fields.set(k, row)
        return row
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        for (const r of fields.values()) if (r.id === where.id) return r
        throw new Error('not found')
      },
    },
    interaction: {
      create: async ({ data }: { data: Partial<InMemInteraction> & { id: string; type: string; occurredAt: Date } }) => {
        const row: InMemInteraction = {
          id: data.id,
          type: data.type,
          contactId: data.contactId ?? null,
          familyId: data.familyId ?? null,
          occurredAt: data.occurredAt,
          summary: data.summary ?? null,
          payload: data.payload ?? {},
          createdAt: new Date(),
          createdById: data.createdById ?? null,
        }
        interactions.push(row)
        return row
      },
    },
    auditLogEntry: {
      findFirst: async () => null,
      create: async ({ data }: { data: InMemAudit }) => {
        audits.push(data)
        return { id: data.id }
      },
    },
  }

  return { db, flags, fields, interactions, audits, id }
}

// ----- KMS mock ----------------------------------------------------------------

const kmsMock = mockClient(KMSClient)

beforeEach(() => {
  process.env['AWS_KMS_KEY_ID'] = 'alias/crm-test'
  process.env['DEFAULT_DSL_USER_ID'] = 'dsl-user-1'
  kmsMock.reset()
  const dek = randomBytes(32)
  kmsMock.on(GenerateDataKeyCommand).resolves({
    Plaintext: dek,
    CiphertextBlob: Buffer.from('wrapped'),
    KeyId: 'alias/crm-test',
  })
  kmsMock.on(DecryptCommand).resolves({ Plaintext: dek })
  setKmsClient(new KMSClient({ region: 'eu-west-2' }))
})

afterEach(() => {
  setKmsClient(null)
  kmsMock.reset()
  setRestrictedGuardDb(null)
})

// ----- The flow ----------------------------------------------------------------

describe('safeguarding integration: raise → triage → escalate', () => {
  it('raises a concern, encrypts the body, audits, and notifies DSL', async () => {
    const { db, flags, interactions, audits, fields } = makeFakeDb()
    const notified: unknown[] = []
    const sent: unknown[] = []
    const result = await raiseConcern(
      db as never,
      {
        contactId: 'contact-1',
        raisedBy: 'agent-1',
        sourceType: 'call',
        sourceId: 'aircall-9',
        urgency: 'urgent',
        body: 'Disclosure of bruising on the arm.',
        isInPlacement: true,
      },
      {
        actorId: 'agent-1',
        requestId: 'req-1',
        notifyDsl: async (i) => void notified.push(i),
        sendEvent: async (i) => void sent.push(i),
      },
    )

    expect(flags.get(result.flagId)?.state).toBe('concern_logged')
    expect(flags.get(result.flagId)?.dslUserId).toBe('dsl-user-1')
    expect(notified).toHaveLength(1)
    // Encrypted body present, plaintext is not in any timeline payload.
    expect([...fields.values()].some((f) => f.column.startsWith('safeguarding_body:'))).toBe(true)
    const concernRow = interactions.find((i) => i.type === 'safeguarding_concern_raised')
    expect(concernRow).toBeDefined()
    const payload = concernRow!.payload as Record<string, unknown>
    expect(JSON.stringify(payload)).not.toContain('Disclosure of bruising')
    // Audit was written.
    expect(audits.some((a) => a.action === 'safeguarding.concern_raised')).toBe(true)
    // Urgent does NOT page (only immediate does).
    expect(sent).toHaveLength(0)
  })

  it('immediate urgency emits dsl/page', async () => {
    const { db } = makeFakeDb()
    const sent: { name: string }[] = []
    await raiseConcern(
      db as never,
      {
        contactId: 'contact-2',
        raisedBy: 'agent-1',
        sourceType: 'call',
        sourceId: null,
        urgency: 'immediate',
        body: 'x',
        isInPlacement: false,
      },
      {
        actorId: 'agent-1',
        requestId: 'req-2',
        sendEvent: async (e) => void sent.push(e),
      },
    )
    expect(sent.find((e) => e.name === 'dsl/page')).toBeDefined()
  })

  it('triageAction escalates to restricted_access only by assigned DSL', async () => {
    const { db, flags } = makeFakeDb()
    const { flagId } = await raiseConcern(
      db as never,
      {
        contactId: 'contact-3',
        raisedBy: 'agent-1',
        sourceType: 'message',
        sourceId: null,
        urgency: 'routine',
        body: 'concern',
        isInPlacement: false,
      },
      { actorId: 'agent-1', requestId: 'req-3' },
    )

    // Wrong DSL is rejected.
    await expect(
      triageAction(
        db as never,
        { flagId, action: 'escalate_restricted', rationale: 'attempt' },
        { actorId: 'other-dsl', requestId: 'r', role: 'dsl' },
      ),
    ).rejects.toThrow(/assigned DSL/i)

    // Assigned DSL succeeds.
    await triageAction(
      db as never,
      { flagId, action: 'escalate_restricted', rationale: 'serious' },
      { actorId: 'dsl-user-1', requestId: 'r', role: 'dsl' },
    )
    expect(flags.get(flagId)?.state).toBe('restricted_access')
  })

  it('AI client refuses to send a prompt for a restricted contact', async () => {
    const { db } = makeFakeDb()
    const { flagId } = await raiseConcern(
      db as never,
      {
        contactId: 'contact-4',
        raisedBy: 'agent-1',
        sourceType: 'note',
        sourceId: null,
        urgency: 'routine',
        body: 'concern',
        isInPlacement: false,
      },
      { actorId: 'agent-1', requestId: 'req-4' },
    )
    await triageAction(
      db as never,
      { flagId, action: 'escalate_restricted', rationale: 'protect' },
      { actorId: 'dsl-user-1', requestId: 'r', role: 'dsl' },
    )

    // Wire the guard to our fake db.
    setRestrictedGuardDb(db as never)
    await expect(
      runStructured({
        task: 'call_outcome_classification',
        promptVersion: 'v1',
        schema: z.object({ outcome: z.string() }),
        system: 's',
        user: 'u',
        contactId: 'contact-4',
      }),
    ).rejects.toThrow(/restricted/i)
  })

  it('LA referral writes a typed safeguarding_la_referral interaction', async () => {
    const { db, interactions } = makeFakeDb()
    const { flagId } = await raiseConcern(
      db as never,
      {
        contactId: 'contact-5',
        raisedBy: 'agent-1',
        sourceType: 'email',
        sourceId: null,
        urgency: 'routine',
        body: 'concern',
        isInPlacement: false,
      },
      { actorId: 'agent-1', requestId: 'req-5' },
    )
    await recordLaReferral(
      db as never,
      {
        flagId,
        la: 'Camden',
        caseworker: 'A. Worker',
        referenceNumber: 'CAM-2026-0001',
        channel: 'portal',
      },
      { actorId: 'dsl-user-1', requestId: 'r' },
    )
    const referral = interactions.find((i) => i.type === 'safeguarding_la_referral')
    expect(referral).toBeDefined()
    const payload = referral!.payload as Record<string, unknown>
    expect(payload['la']).toBe('Camden')
    expect(payload['referenceNumber']).toBe('CAM-2026-0001')
    // Caseworker must NOT be in the timeline payload (only in the encrypted body).
    expect(JSON.stringify(payload)).not.toContain('A. Worker')
  })

  it('audit row is written before plaintext is decrypted (decryptFieldById)', async () => {
    const { db, fields, audits } = makeFakeDb()
    await raiseConcern(
      db as never,
      {
        contactId: 'contact-6',
        raisedBy: 'agent-1',
        sourceType: 'note',
        sourceId: null,
        urgency: 'routine',
        body: 'sensitive plaintext',
        isInPlacement: false,
      },
      { actorId: 'agent-1', requestId: 'req-6' },
    )
    // Reset audits so we can see only the decrypt one.
    audits.length = 0
    const encRow = [...fields.values()][0]!
    const { decryptFieldById } = await import('@studymind/core/safeguarding')
    const plaintext = await decryptFieldById(db as never, {
      encryptedFieldId: encRow.id,
      actorId: 'dsl-user-1',
      purpose: 'triage review',
    })
    expect(plaintext).toBe('sensitive plaintext')
    // The audit row sits at index 0 — written BEFORE decryption.
    expect(audits[0]?.action).toBe('safeguarding.field_decrypted')
    expect(audits[0]?.purpose).toBe('triage review')
  })
})
