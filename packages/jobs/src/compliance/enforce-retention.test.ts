// Tests for the retention engine. Synthetic in-memory DB; no IO.

import { describe, expect, it } from 'vitest'

import {
  CRYPTO_SHRED_PREFIX,
  enforceRetentionOnce,
  hardDeleteInteractions,
  hardDeleteLeads,
  softDeleteCategory,
  type EncryptedFieldRow,
  type InteractionRow,
  type LeadRow,
  type RetentionDb,
  type S3Deleter,
} from './enforce-retention'

// -----------------------------------------------------------------------------
// In-memory fake DB
// -----------------------------------------------------------------------------

interface State {
  interactions: InteractionRow[]
  leads: LeadRow[]
  encryptedFields: EncryptedFieldRow[]
}

function pickFields<T extends object>(row: T, sel: Record<string, true>): T {
  const out = {} as Record<string, unknown>
  for (const k of Object.keys(sel)) out[k] = (row as Record<string, unknown>)[k]
  return out as T
}

function ageInDays(row: InteractionRow | LeadRow, now: Date): number {
  const t = 'occurredAt' in row ? row.occurredAt.getTime() : row.createdAt.getTime()
  return (now.getTime() - t) / (1000 * 60 * 60 * 24)
}

function makeDb(state: State): RetentionDb {
  return {
    interaction: {
      findMany: async ({ where, take, select }) => {
        const w = where as Record<string, unknown>
        const filtered = state.interactions.filter((row) => {
          if ('softDeletedAt' in w && w['softDeletedAt'] === null) {
            if (row.softDeletedAt !== null) return false
          }
          if (w['pendingHardDeleteAt']) {
            const cmp = w['pendingHardDeleteAt'] as { lt: Date }
            if (!row.pendingHardDeleteAt || row.pendingHardDeleteAt >= cmp.lt) return false
          }
          if (w['occurredAt']) {
            const cmp = w['occurredAt'] as { lt: Date }
            if (row.occurredAt >= cmp.lt) return false
          }
          if (w['type']) {
            const ti = w['type'] as { in: string[] }
            if (!ti.in.includes(row.type)) return false
          }
          if (w['payload']) {
            const cmp = w['payload'] as { path: string[]; not: unknown }
            const p = (row.payload ?? {}) as Record<string, unknown>
            const v = p[cmp.path[0] as string]
            if (v === undefined || v === null) return false
          }
          return true
        })
        return filtered.slice(0, take).map((r) => pickFields(r, select))
      },
      updateMany: async ({ where, data }) => {
        let count = 0
        for (const row of state.interactions) {
          if (where.id.in.includes(row.id)) {
            row.softDeletedAt = data.softDeletedAt
            row.pendingHardDeleteAt = data.pendingHardDeleteAt
            count += 1
          }
        }
        return { count }
      },
      deleteMany: async ({ where }) => {
        const before = state.interactions.length
        state.interactions = state.interactions.filter((r) => !where.id.in.includes(r.id))
        return { count: before - state.interactions.length }
      },
    },
    lead: {
      findMany: async ({ where, take, select }) => {
        const w = where as Record<string, unknown>
        const filtered = state.leads.filter((row) => {
          if ('softDeletedAt' in w && w['softDeletedAt'] === null) {
            if (row.softDeletedAt !== null) return false
          }
          if ('convertedAt' in w && w['convertedAt'] === null) {
            if (row.convertedAt !== null) return false
          }
          if (w['createdAt']) {
            const cmp = w['createdAt'] as { lt: Date }
            if (row.createdAt >= cmp.lt) return false
          }
          if (w['pendingHardDeleteAt']) {
            const cmp = w['pendingHardDeleteAt'] as { lt: Date }
            if (!row.pendingHardDeleteAt || row.pendingHardDeleteAt >= cmp.lt) return false
          }
          return true
        })
        return filtered.slice(0, take).map((r) => pickFields(r, select))
      },
      updateMany: async ({ where, data }) => {
        let count = 0
        for (const row of state.leads) {
          if (where.id.in.includes(row.id)) {
            row.softDeletedAt = data.softDeletedAt
            row.pendingHardDeleteAt = data.pendingHardDeleteAt
            count += 1
          }
        }
        return { count }
      },
      deleteMany: async ({ where }) => {
        const before = state.leads.length
        state.leads = state.leads.filter((r) => !where.id.in.includes(r.id))
        return { count: before - state.leads.length }
      },
    },
    encryptedField: {
      findMany: async ({ where, select }) => {
        const filtered = state.encryptedFields.filter((row) => {
          if (row.contactId !== where.contactId) return false
          if (where.column.startsWith && !row.column.startsWith(where.column.startsWith)) {
            return false
          }
          return true
        })
        return filtered.map((r) => pickFields(r, select))
      },
      updateMany: async ({ where, data }) => {
        let count = 0
        for (const row of state.encryptedFields) {
          if (where.id.in.includes(row.id)) {
            row.dekCiphertext = data.dekCiphertext
            count += 1
          }
        }
        return { count }
      },
    },
  }
}

function ix(partial: Partial<InteractionRow> & { id: string; type: string; occurredAt: Date }): InteractionRow {
  return {
    createdAt: partial.occurredAt,
    payload: {},
    softDeletedAt: null,
    pendingHardDeleteAt: null,
    ...partial,
  }
}

function lead(partial: Partial<LeadRow> & { id: string; createdAt: Date }): LeadRow {
  return {
    convertedAt: null,
    softDeletedAt: null,
    pendingHardDeleteAt: null,
    ...partial,
  }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('softDeleteCategory', () => {
  const now = new Date('2026-05-10T00:00:00Z')

  it('soft-deletes emails older than 7 years', async () => {
    const old = new Date('2018-01-01T00:00:00Z')
    const young = new Date('2025-12-01T00:00:00Z')
    const state: State = {
      interactions: [
        ix({ id: 'e-old', type: 'email_received', occurredAt: old }),
        ix({ id: 'e-young', type: 'email_sent', occurredAt: young }),
      ],
      leads: [],
      encryptedFields: [],
    }
    const db = makeDb(state)
    const r = await softDeleteCategory(db, 'email', now)
    expect(r.softDeleted).toBe(1)
    expect(state.interactions.find((i) => i.id === 'e-old')?.softDeletedAt).toEqual(now)
    expect(state.interactions.find((i) => i.id === 'e-young')?.softDeletedAt).toBeNull()
  })

  it('soft-deletes call recordings older than 90 days', async () => {
    const old = new Date('2025-12-01T00:00:00Z') // > 90d before now
    const state: State = {
      interactions: [
        ix({
          id: 'c-old',
          type: 'call',
          occurredAt: old,
          payload: { recordingS3Key: 'aircall/recordings/x.mp3' },
        }),
        ix({ id: 'c-no-recording', type: 'call', occurredAt: old, payload: {} }),
      ],
      leads: [],
      encryptedFields: [],
    }
    const r = await softDeleteCategory(makeDb(state), 'callRecording', now)
    expect(r.softDeleted).toBe(1)
    expect(state.interactions.find((i) => i.id === 'c-old')?.softDeletedAt).toEqual(now)
    expect(state.interactions.find((i) => i.id === 'c-no-recording')?.softDeletedAt).toBeNull()
  })

  it('soft-deletes unconverted leads older than 12 months', async () => {
    const old = new Date('2024-01-01T00:00:00Z')
    const state: State = {
      interactions: [],
      leads: [
        lead({ id: 'l-unconverted', createdAt: old, convertedAt: null }),
        lead({ id: 'l-converted', createdAt: old, convertedAt: new Date('2024-06-01T00:00:00Z') }),
      ],
      encryptedFields: [],
    }
    const r = await softDeleteCategory(makeDb(state), 'marketingLead', now)
    expect(r.softDeleted).toBe(1)
    expect(state.leads.find((l) => l.id === 'l-unconverted')?.softDeletedAt).toEqual(now)
    expect(state.leads.find((l) => l.id === 'l-converted')?.softDeletedAt).toBeNull()
    // Confirm: ageInDays > 365
    expect(ageInDays(state.leads[0]!, now)).toBeGreaterThan(365)
  })

  it('is idempotent — second pass is a no-op', async () => {
    const old = new Date('2018-01-01T00:00:00Z')
    const state: State = {
      interactions: [ix({ id: 'e1', type: 'email', occurredAt: old })],
      leads: [],
      encryptedFields: [],
    }
    const db = makeDb(state)
    expect((await softDeleteCategory(db, 'email', now)).softDeleted).toBe(1)
    expect((await softDeleteCategory(db, 'email', now)).softDeleted).toBe(0)
  })
})

describe('hardDeleteInteractions', () => {
  const now = new Date('2026-05-10T00:00:00Z')

  it('hard-deletes recordings + calls S3 deleteObject + crypto-shreds DEK', async () => {
    const past = new Date('2026-04-01T00:00:00Z') // pendingHardDeleteAt < now
    const state: State = {
      interactions: [
        ix({
          id: 'r1',
          type: 'call',
          occurredAt: new Date('2025-09-01T00:00:00Z'),
          softDeletedAt: new Date('2026-03-01T00:00:00Z'),
          pendingHardDeleteAt: past,
          payload: {
            recordingS3Key: 'aircall/recordings/r1.mp3',
            attachmentS3Keys: ['aircall/transcripts/r1.txt'],
            encryptedFieldKey: 'safeguarding_body:flag-1',
            contactId: 'contact-1',
          },
        }),
      ],
      leads: [],
      encryptedFields: [
        {
          id: 'ef-1',
          contactId: 'contact-1',
          column: 'safeguarding_body:flag-1',
          dekCiphertext: Buffer.from('original-cipher'),
        },
      ],
    }
    const deleted: string[] = []
    const s3: S3Deleter = { deleteObject: async (k) => void deleted.push(k) }
    const r = await hardDeleteInteractions(makeDb(state), now, s3)
    expect(r.hardDeleted).toBe(1)
    expect(r.s3Deletions).toBe(2)
    expect(r.cryptoShredded).toBe(1)
    expect(deleted).toEqual([
      'aircall/recordings/r1.mp3',
      'aircall/transcripts/r1.txt',
    ])
    expect(state.interactions).toHaveLength(0)
    expect(String(state.encryptedFields[0]!.dekCiphertext)).toContain(CRYPTO_SHRED_PREFIX)
  })

  it('does not touch rows whose grace has not elapsed', async () => {
    const future = new Date('2026-06-01T00:00:00Z')
    const state: State = {
      interactions: [
        ix({
          id: 'soft-only',
          type: 'email',
          occurredAt: new Date('2018-01-01T00:00:00Z'),
          softDeletedAt: now,
          pendingHardDeleteAt: future,
        }),
      ],
      leads: [],
      encryptedFields: [],
    }
    const r = await hardDeleteInteractions(makeDb(state), now)
    expect(r.hardDeleted).toBe(0)
    expect(state.interactions).toHaveLength(1)
  })
})

describe('hardDeleteLeads', () => {
  const now = new Date('2026-05-10T00:00:00Z')
  it('hard-deletes leads whose grace has elapsed', async () => {
    const state: State = {
      interactions: [],
      leads: [
        lead({
          id: 'l-grace-expired',
          createdAt: new Date('2024-01-01T00:00:00Z'),
          softDeletedAt: new Date('2026-03-01T00:00:00Z'),
          pendingHardDeleteAt: new Date('2026-04-01T00:00:00Z'),
        }),
      ],
      encryptedFields: [],
    }
    const r = await hardDeleteLeads(makeDb(state), now)
    expect(r.hardDeleted).toBe(1)
    expect(state.leads).toHaveLength(0)
  })
})

describe('enforceRetentionOnce — end-to-end', () => {
  it('soft-then-hard sweeps an old email across two runs', async () => {
    const old = new Date('2018-01-01T00:00:00Z')
    const day1 = new Date('2026-05-10T00:00:00Z')
    const day31 = new Date('2026-06-10T00:00:00Z')
    const state: State = {
      interactions: [ix({ id: 'e1', type: 'email_received', occurredAt: old })],
      leads: [],
      encryptedFields: [],
    }
    const db = makeDb(state)
    await enforceRetentionOnce(db, day1)
    expect(state.interactions[0]!.softDeletedAt).toEqual(day1)
    expect(state.interactions[0]!.pendingHardDeleteAt).toBeTruthy()

    await enforceRetentionOnce(db, day31)
    expect(state.interactions).toHaveLength(0)
  })

  it('writes audit entries for batches with non-zero counts', async () => {
    const old = new Date('2024-01-01T00:00:00Z')
    const now = new Date('2026-05-10T00:00:00Z')
    const state: State = {
      interactions: [],
      leads: [lead({ id: 'l-old', createdAt: old, convertedAt: null })],
      encryptedFields: [],
    }
    const audit: { entries: unknown[] } = { entries: [] }
    await enforceRetentionOnce(makeDb(state), now, undefined, {
      write: async (e) => void audit.entries.push(e),
    })
    expect(audit.entries.length).toBeGreaterThan(0)
    expect(
      (audit.entries as Array<{ action: string }>).some(
        (e) => e.action === 'compliance.retention.soft_delete_batch',
      ),
    ).toBe(true)
  })
})
