// Unit tests for loadContactCommsCounts — the one groupBy that powers the
// Contacts list's calls/texts/emails columns. We stub the Prisma client so
// the tests are pure unit-tests; the real groupBy is exercised by the wider
// integration suite.

import { describe, it, expect, vi } from 'vitest'

import {
  loadContactCommsCounts,
  loadContactComplaintCounts,
  loadContactEnquiryTypes,
  MAX_ENQUIRY_TYPES,
} from './contact-stats'

interface FakeGroup {
  contactId: string | null
  type: string
  _count: { _all: number }
}

function fakeDb(groups: FakeGroup[]) {
  return {
    interaction: {
      groupBy: vi.fn().mockResolvedValue(groups),
    },
    // Cast through unknown so the test fake matches the loose Db param type
    // without dragging the full Prisma surface into the test file.
  } as unknown as Parameters<typeof loadContactCommsCounts>[0]
}

describe('loadContactCommsCounts', () => {
  it('returns an empty map for no input', async () => {
    const out = await loadContactCommsCounts(fakeDb([]), [])
    expect(out.size).toBe(0)
  })

  it('seeds every requested contact with zero counts', async () => {
    const out = await loadContactCommsCounts(fakeDb([]), ['a', 'b'])
    expect(out.get('a')).toEqual({ callCount: 0, emailCount: 0, textCount: 0 })
    expect(out.get('b')).toEqual({ callCount: 0, emailCount: 0, textCount: 0 })
  })

  it('routes call / message / email types to the right buckets', async () => {
    const out = await loadContactCommsCounts(
      fakeDb([
        { contactId: 'a', type: 'call', _count: { _all: 3 } },
        { contactId: 'a', type: 'message', _count: { _all: 2 } },
        { contactId: 'a', type: 'email', _count: { _all: 1 } },
        { contactId: 'a', type: 'email_received', _count: { _all: 4 } },
        { contactId: 'a', type: 'email_sent', _count: { _all: 5 } },
      ]),
      ['a'],
    )
    expect(out.get('a')).toEqual({ callCount: 3, emailCount: 10, textCount: 2 })
  })

  it('ignores rows for contacts not in the input set', async () => {
    const out = await loadContactCommsCounts(
      fakeDb([
        { contactId: 'a', type: 'call', _count: { _all: 1 } },
        { contactId: 'ghost', type: 'call', _count: { _all: 99 } },
      ]),
      ['a'],
    )
    expect(out.get('a')?.callCount).toBe(1)
    expect(out.has('ghost')).toBe(false)
  })

  it('ignores rows with a null contactId (family-only Interactions)', async () => {
    const out = await loadContactCommsCounts(
      fakeDb([{ contactId: null, type: 'call', _count: { _all: 5 } }]),
      ['a'],
    )
    expect(out.get('a')?.callCount).toBe(0)
  })
})

interface FakeComplaintGroup {
  contactId: string
  _count: { _all: number }
}

function fakeComplaintDb(groups: FakeComplaintGroup[]) {
  return {
    complaint: {
      groupBy: vi.fn().mockResolvedValue(groups),
    },
  } as unknown as Parameters<typeof loadContactComplaintCounts>[0]
}

describe('loadContactComplaintCounts', () => {
  it('returns an empty map for no input', async () => {
    const out = await loadContactComplaintCounts(fakeComplaintDb([]), [])
    expect(out.size).toBe(0)
  })

  it('seeds every requested contact with zero', async () => {
    const out = await loadContactComplaintCounts(fakeComplaintDb([]), ['a', 'b'])
    expect(out.get('a')).toBe(0)
    expect(out.get('b')).toBe(0)
  })

  it('maps each contact to its active-complaint count', async () => {
    const out = await loadContactComplaintCounts(
      fakeComplaintDb([
        { contactId: 'a', _count: { _all: 3 } },
        { contactId: 'b', _count: { _all: 1 } },
      ]),
      ['a', 'b'],
    )
    expect(out.get('a')).toBe(3)
    expect(out.get('b')).toBe(1)
  })

  it('filters the query to active statuses (open | in_progress)', async () => {
    const db = fakeComplaintDb([])
    await loadContactComplaintCounts(db, ['a'])
    const groupBy = (db as unknown as { complaint: { groupBy: ReturnType<typeof vi.fn> } })
      .complaint.groupBy
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          status: { in: ['open', 'in_progress'] },
        }),
      }),
    )
  })
})

interface FakeLead {
  convertedToContactId: string | null
  categories: string[]
}

function fakeLeadDb(leads: FakeLead[]) {
  return {
    lead: {
      findMany: vi.fn().mockResolvedValue(leads),
    },
  } as unknown as Parameters<typeof loadContactEnquiryTypes>[0]
}

describe('loadContactEnquiryTypes', () => {
  it('returns an empty map for no input', async () => {
    const out = await loadContactEnquiryTypes(fakeLeadDb([]), [])
    expect(out.size).toBe(0)
  })

  it('seeds every requested contact with an empty list', async () => {
    const out = await loadContactEnquiryTypes(fakeLeadDb([]), ['a', 'b'])
    expect(out.get('a')).toEqual([])
    expect(out.get('b')).toEqual([])
  })

  it('unions categories latest-first without duplicates', async () => {
    // findMany is ordered createdAt desc, so the first row is the latest ask.
    const out = await loadContactEnquiryTypes(
      fakeLeadDb([
        { convertedToContactId: 'a', categories: ['Summer Camp'] },
        { convertedToContactId: 'a', categories: ['Tutoring', 'Summer Camp'] },
        { convertedToContactId: 'a', categories: ['UCAT'] },
      ]),
      ['a'],
    )
    expect(out.get('a')).toEqual(['Summer Camp', 'Tutoring', 'UCAT'])
  })

  it('caps the union at MAX_ENQUIRY_TYPES', async () => {
    const out = await loadContactEnquiryTypes(
      fakeLeadDb([
        {
          convertedToContactId: 'a',
          categories: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'],
        },
      ]),
      ['a'],
    )
    expect(out.get('a')).toHaveLength(MAX_ENQUIRY_TYPES)
    expect(out.get('a')).toEqual(['One', 'Two', 'Three', 'Four', 'Five', 'Six'])
  })

  it('ignores leads for contacts not in the input set', async () => {
    const out = await loadContactEnquiryTypes(
      fakeLeadDb([{ convertedToContactId: 'ghost', categories: ['UCAT'] }]),
      ['a'],
    )
    expect(out.get('a')).toEqual([])
    expect(out.has('ghost')).toBe(false)
  })
})
