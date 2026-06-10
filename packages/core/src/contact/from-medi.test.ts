// Unit tests for the Medi account Contact resolver. We stub Prisma + the audit
// writer so these stay pure unit tests; the real DB path is the same shape as
// from-call.ts and is exercised by the wider integration suite.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveOrCreateContactForMediAccount } from './from-medi'
import type { NormalisedMediParty } from '../medi/types'

vi.mock('@studymind/audit', () => ({ writeAuditLogEntry: vi.fn().mockResolvedValue('audit-id') }))

interface Row {
  id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
}

function fakeDb(opts: { byEmail?: Row[]; byPhone?: Row[] }) {
  const created: Array<Record<string, unknown>> = []
  const updated: Array<{ where: { id: string }; data: Record<string, unknown> }> = []
  const db = {
    contact: {
      findMany: vi.fn(async ({ where }: { where: { email?: string; phoneE164?: string } }) => {
        if (where.email) return opts.byEmail ?? []
        if (where.phoneE164) return opts.byPhone ?? []
        return []
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updated.push(args)
        return { id: args.where.id }
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
        return data
      }),
    },
  }
  return { db: db as unknown as Parameters<typeof resolveOrCreateContactForMediAccount>[0], created, updated }
}

const party = (over: Partial<NormalisedMediParty> = {}): NormalisedMediParty => ({
  firstName: 'Jordan',
  lastName: 'Smith',
  email: 'jordan@example.com',
  phoneE164: '+447700900123',
  ...over,
})

const opts = {
  referralSource: 'Medi Platform (UCAT portal)',
  kind: 'student' as const,
  actorId: 'system:test',
  requestId: 'evt-1',
}

describe('resolveOrCreateContactForMediAccount', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a Contact when nothing matches', async () => {
    const { db, created } = fakeDb({})
    const res = await resolveOrCreateContactForMediAccount(db, party(), opts)
    expect(res).toMatchObject({ created: true, matchedBy: null, triageRequired: false })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      kind: 'student',
      email: 'jordan@example.com',
      phoneE164: '+447700900123',
      firstName: 'Jordan',
      referralSource: 'Medi Platform (UCAT portal)',
    })
  })

  it('reuses a single email match and backfills only blank fields', async () => {
    const { db, created, updated } = fakeDb({
      byEmail: [{ id: 'c1', firstName: null, lastName: 'Smith', email: 'jordan@example.com', phoneE164: null }],
    })
    const res = await resolveOrCreateContactForMediAccount(db, party(), opts)
    expect(res).toMatchObject({ contactId: 'c1', created: false, matchedBy: 'email' })
    expect(created).toHaveLength(0)
    expect(updated).toHaveLength(1)
    // firstName + phone were blank → backfilled; lastName already set → untouched.
    expect(updated[0]!.data).toMatchObject({ firstName: 'Jordan', phoneE164: '+447700900123' })
    expect(updated[0]!.data).not.toHaveProperty('lastName')
  })

  it('does not update when the matched contact already has every field', async () => {
    const { db, updated } = fakeDb({
      byEmail: [{ id: 'c1', firstName: 'J', lastName: 'S', email: 'jordan@example.com', phoneE164: '+447700900123' }],
    })
    const res = await resolveOrCreateContactForMediAccount(db, party(), opts)
    expect(res).toMatchObject({ contactId: 'c1', created: false })
    expect(updated).toHaveLength(0)
  })

  it('flags triage when several contacts share the email (never auto-merge)', async () => {
    const { db } = fakeDb({
      byEmail: [
        { id: 'old', firstName: 'J', lastName: 'S', email: 'jordan@example.com', phoneE164: '+447700900123' },
        { id: 'dupe', firstName: 'J', lastName: 'S', email: 'jordan@example.com', phoneE164: null },
      ],
    })
    const res = await resolveOrCreateContactForMediAccount(db, party(), opts)
    expect(res).toMatchObject({ contactId: 'old', triageRequired: true, matchedBy: 'email' })
  })

  it('falls back to a phone match when there is no email match', async () => {
    const { db } = fakeDb({
      byEmail: [],
      byPhone: [{ id: 'p1', firstName: 'J', lastName: 'S', email: null, phoneE164: '+447700900123' }],
    })
    const res = await resolveOrCreateContactForMediAccount(db, party({ email: 'new@example.com' }), opts)
    expect(res).toMatchObject({ contactId: 'p1', created: false, matchedBy: 'phone' })
  })

  it('returns null when there is nothing to key on', async () => {
    const { db } = fakeDb({})
    const res = await resolveOrCreateContactForMediAccount(
      db,
      party({ email: null, phoneE164: null }),
      opts,
    )
    expect(res).toBeNull()
    expect(db.contact.findMany).not.toHaveBeenCalled()
  })
})
