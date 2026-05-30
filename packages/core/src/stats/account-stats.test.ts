// Unit tests for loadAccountStats. The aggregator walks five batched queries:
// students+hours, paid invoices, link map, comms counts, last contacted. We
// stub Prisma so the routing logic (a contact on multiple accounts must
// fan-out) is asserted in isolation.

import { describe, it, expect, vi } from 'vitest'

import { loadAccountStats } from './account-stats'

function fakeDb(opts: {
  students?: Array<{
    accountId: string
    _count: { _all: number }
    _sum: { hoursContracted: number | null; hoursDelivered: number | null }
  }>
  invoices?: Array<{
    businessAccountId: string | null
    _sum: { amountMinor: number | null }
  }>
  links?: Array<{ accountId: string; contactId: string }>
  groups?: Array<{
    contactId: string | null
    type: string
    _count: { _all: number }
  }>
  last?: Array<{ contactId: string | null; _max: { occurredAt: Date | null } }>
}) {
  return {
    businessAccountStudent: { groupBy: vi.fn().mockResolvedValue(opts.students ?? []) },
    uploadedInvoice: { groupBy: vi.fn().mockResolvedValue(opts.invoices ?? []) },
    businessAccountContact: { findMany: vi.fn().mockResolvedValue(opts.links ?? []) },
    interaction: {
      groupBy: vi
        .fn()
        .mockResolvedValueOnce(opts.groups ?? [])
        .mockResolvedValueOnce(opts.last ?? []),
    },
  } as unknown as Parameters<typeof loadAccountStats>[0]
}

describe('loadAccountStats', () => {
  it('returns an empty map for no input', async () => {
    const out = await loadAccountStats(fakeDb({}), [])
    expect(out.size).toBe(0)
  })

  it('rolls students + hours per account', async () => {
    const out = await loadAccountStats(
      fakeDb({
        students: [
          {
            accountId: 'A1',
            _count: { _all: 4 },
            _sum: { hoursContracted: 10, hoursDelivered: 6 },
          },
        ],
      }),
      ['A1'],
    )
    expect(out.get('A1')).toMatchObject({
      studentCount: 4,
      hoursContracted: 10,
      hoursDelivered: 6,
    })
  })

  it('only counts paid uploaded invoices for spend', async () => {
    const out = await loadAccountStats(
      fakeDb({
        invoices: [{ businessAccountId: 'A1', _sum: { amountMinor: 12345 } }],
      }),
      ['A1'],
    )
    expect(out.get('A1')?.amountPaidMinor).toBe(12345)
  })

  it('fans comms counts across every account a contact is linked to', async () => {
    const out = await loadAccountStats(
      fakeDb({
        links: [
          { accountId: 'A1', contactId: 'c1' },
          { accountId: 'A2', contactId: 'c1' },
        ],
        groups: [
          { contactId: 'c1', type: 'call', _count: { _all: 2 } },
          { contactId: 'c1', type: 'message', _count: { _all: 1 } },
          { contactId: 'c1', type: 'email_received', _count: { _all: 3 } },
        ],
      }),
      ['A1', 'A2'],
    )
    expect(out.get('A1')).toMatchObject({
      callCount: 2,
      textCount: 1,
      emailCount: 3,
    })
    expect(out.get('A2')).toMatchObject({
      callCount: 2,
      textCount: 1,
      emailCount: 3,
    })
  })

  it('keeps the newest occurredAt across linked contacts', async () => {
    const old = new Date('2026-01-01T00:00:00Z')
    const recent = new Date('2026-05-01T00:00:00Z')
    const out = await loadAccountStats(
      fakeDb({
        links: [
          { accountId: 'A1', contactId: 'c1' },
          { accountId: 'A1', contactId: 'c2' },
        ],
        last: [
          { contactId: 'c1', _max: { occurredAt: old } },
          { contactId: 'c2', _max: { occurredAt: recent } },
        ],
      }),
      ['A1'],
    )
    expect(out.get('A1')?.lastContactedAt).toEqual(recent)
  })

  it('defaults to zero / null when nothing matches', async () => {
    const out = await loadAccountStats(fakeDb({}), ['A1'])
    expect(out.get('A1')).toEqual({
      studentCount: 0,
      hoursContracted: 0,
      hoursDelivered: 0,
      amountPaidMinor: 0,
      callCount: 0,
      textCount: 0,
      emailCount: 0,
      lastContactedAt: null,
    })
  })
})
