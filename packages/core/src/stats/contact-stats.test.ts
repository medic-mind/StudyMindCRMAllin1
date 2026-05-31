// Unit tests for loadContactCommsCounts — the one groupBy that powers the
// Contacts list's calls/texts/emails columns. We stub the Prisma client so
// the tests are pure unit-tests; the real groupBy is exercised by the wider
// integration suite.

import { describe, it, expect, vi } from 'vitest'

import { loadContactCommsCounts } from './contact-stats'

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
