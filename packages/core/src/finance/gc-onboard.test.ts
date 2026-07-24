// Unit tests for the GoCardless → CRM auto-onboard resolver (ADR 0038 / 0045).
// `linkGcCustomer` and the audit writer are mocked so we exercise the decision
// branches (already-linked / match / ambiguous / create / no-identity) in
// isolation.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { linkGcCustomer } = vi.hoisted(() => ({ linkGcCustomer: vi.fn(async () => ({ ok: true })) }))
const { writeAuditLogEntry } = vi.hoisted(() => ({
  writeAuditLogEntry: vi.fn(async () => 'audit-id'),
}))

vi.mock('./gc-mirror', () => ({ linkGcCustomer }))
vi.mock('@studymind/audit', () => ({ writeAuditLogEntry }))

import { gcCustomerDisplayName, resolveOrCreateContactForGcCustomer } from './gc-onboard'

interface Customer {
  email: string | null
  givenName: string | null
  familyName: string | null
  companyName: string | null
  phone: string | null
  contactId: string | null
}

function makeDb(opts: {
  customer?: Customer | null
  liveContact?: { id: string } | null
  matches?: { id: string }[]
}) {
  const created: Array<Record<string, unknown>> = []
  const db = {
    gcCustomer: {
      findUnique: async () => opts.customer ?? null,
    },
    contact: {
      // step 1: already-linked live check.
      findFirst: async () => opts.liveContact ?? null,
      // step 2: email/phone matches (ordered updatedAt desc by the resolver).
      findMany: async () => opts.matches ?? [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
        return data
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { db, created }
}

const OPTS = { actorId: null as string | null }

beforeEach(() => {
  linkGcCustomer.mockClear()
  writeAuditLogEntry.mockClear()
})

describe('gcCustomerDisplayName', () => {
  it('prefers given + family, else company, else null', () => {
    expect(gcCustomerDisplayName({ givenName: 'Lamar', familyName: 'Fallatah' })).toBe(
      'Lamar Fallatah',
    )
    expect(gcCustomerDisplayName({ givenName: 'Ilona', familyName: null })).toBe('Ilona')
    expect(gcCustomerDisplayName({ companyName: 'Acme Ltd' })).toBe('Acme Ltd')
    expect(gcCustomerDisplayName({})).toBeNull()
    expect(gcCustomerDisplayName({ givenName: '  ', familyName: '  ' })).toBeNull()
  })
})

describe('resolveOrCreateContactForGcCustomer', () => {
  it('returns the already-linked live contact without creating or re-linking', async () => {
    const { db, created } = makeDb({
      customer: {
        email: 'x@y.com',
        givenName: 'X',
        familyName: null,
        companyName: null,
        phone: null,
        contactId: 'linked-1',
      },
      liveContact: { id: 'linked-1' },
    })
    const res = await resolveOrCreateContactForGcCustomer(db, { gcCustomerId: 'CU' }, OPTS)
    expect(res).toMatchObject({ contactId: 'linked-1', created: false, linked: false })
    expect(created).toHaveLength(0)
    expect(linkGcCustomer).not.toHaveBeenCalled()
  })

  it('links an existing unambiguous email/phone match (never creates a duplicate)', async () => {
    const { db, created } = makeDb({
      customer: {
        email: 'match@y.com',
        givenName: 'Match',
        familyName: 'Ed',
        companyName: null,
        phone: null,
        contactId: null,
      },
      matches: [{ id: 'existing-1' }],
    })
    const res = await resolveOrCreateContactForGcCustomer(db, { gcCustomerId: 'CU' }, OPTS)
    expect(res).toMatchObject({ contactId: 'existing-1', created: false, linked: true })
    expect(created).toHaveLength(0)
    expect(linkGcCustomer).toHaveBeenCalledWith(db, {
      gcCustomerId: 'CU',
      contactId: 'existing-1',
    })
  })

  it('attaches to the most recent of several matches (annotation, never a merge)', async () => {
    const { db, created } = makeDb({
      customer: {
        email: 'shared@y.com',
        givenName: null,
        familyName: null,
        companyName: null,
        phone: null,
        contactId: null,
      },
      // resolver queries orderBy updatedAt desc, so index 0 is the most recent.
      matches: [{ id: 'recent' }, { id: 'older' }],
    })
    const res = await resolveOrCreateContactForGcCustomer(db, { gcCustomerId: 'CU' }, OPTS)
    expect(res.contactId).toBe('recent')
    expect(res.linked).toBe(true)
    expect(created).toHaveLength(0)
    expect(linkGcCustomer).toHaveBeenCalledWith(db, { gcCustomerId: 'CU', contactId: 'recent' })
  })

  it('auto-onboards a new CRM contact from the GoCardless identity when unmatched', async () => {
    const { db, created } = makeDb({
      customer: {
        email: 'lamar@gc.example',
        givenName: 'Lamar',
        familyName: 'Fallatah',
        companyName: null,
        phone: '+447700900321',
        contactId: null,
      },
      matches: [],
    })
    const res = await resolveOrCreateContactForGcCustomer(db, { gcCustomerId: 'CU' }, OPTS)
    expect(res.created).toBe(true)
    expect(res.linked).toBe(true)
    expect(res.contactId).toBe(created[0]!.id)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      kind: 'unclassified',
      firstName: 'Lamar',
      lastName: 'Fallatah',
      email: 'lamar@gc.example',
      phoneE164: '+447700900321',
      referralSource: 'GoCardless',
    })
    // The new contact is linked back to the customer.
    expect(linkGcCustomer).toHaveBeenCalledWith(db, {
      gcCustomerId: 'CU',
      contactId: created[0]!.id,
    })
  })

  it('does not create a ghost when the customer has no name, email or phone', async () => {
    const { db, created } = makeDb({
      customer: {
        email: null,
        givenName: null,
        familyName: null,
        companyName: null,
        phone: null,
        contactId: null,
      },
      matches: [],
    })
    const res = await resolveOrCreateContactForGcCustomer(db, { gcCustomerId: 'CU' }, OPTS)
    expect(res).toMatchObject({ contactId: null, created: false, linked: false })
    expect(created).toHaveLength(0)
    expect(linkGcCustomer).not.toHaveBeenCalled()
  })

  it('returns nulls when the customer is not in the mirror', async () => {
    const { db } = makeDb({ customer: null })
    const res = await resolveOrCreateContactForGcCustomer(db, { gcCustomerId: 'MISSING' }, OPTS)
    expect(res).toMatchObject({ contactId: null, created: false, linked: false })
  })
})
