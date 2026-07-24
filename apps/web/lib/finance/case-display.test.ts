// The never-"Unknown" guarantee for Direct Debit recovery cases. Proves the
// read-time display fallback resolves a real label + email/phone from the
// GoCardless customer / plan name regardless of what the case row stored.

import { describe, expect, it } from 'vitest'

import { composeCaseName, loadGcFallbackForCases, type GcFallback } from './case-display'

const EMPTY: GcFallback = { gcName: null, gcEmail: null, gcPhone: null, planName: null }

describe('composeCaseName', () => {
  it('prefers a linked contact name above everything', () => {
    expect(
      composeCaseName({
        contactName: 'Jane Contact',
        personName: 'Standalone',
        chaseEmail: 'e@x.com',
        chasePhoneE164: '+447700900123',
        fallback: { gcName: 'GC Name', gcEmail: 'gc@x.com', gcPhone: null, planName: 'Plan' },
      }),
    ).toBe('Jane Contact')
  })

  it('falls back through personName → GoCardless name → plan name', () => {
    expect(
      composeCaseName({
        contactName: null,
        personName: 'Standalone Sam',
        chaseEmail: null,
        chasePhoneE164: null,
        fallback: EMPTY,
      }),
    ).toBe('Standalone Sam')

    expect(
      composeCaseName({
        contactName: null,
        personName: null,
        chaseEmail: null,
        chasePhoneE164: null,
        fallback: { ...EMPTY, gcName: 'Lamar Fallatah' },
      }),
    ).toBe('Lamar Fallatah')

    expect(
      composeCaseName({
        contactName: null,
        personName: null,
        chaseEmail: null,
        chasePhoneE164: null,
        fallback: { ...EMPTY, planName: 'Ilona Pisarek 30h LNAT' },
      }),
    ).toBe('Ilona Pisarek 30h LNAT')
  })

  it('uses an email/phone before ever showing "Unknown"', () => {
    expect(
      composeCaseName({
        contactName: null,
        personName: null,
        chaseEmail: 'buyer@x.com',
        chasePhoneE164: null,
        fallback: EMPTY,
      }),
    ).toBe('buyer@x.com')
    expect(
      composeCaseName({
        contactName: null,
        personName: null,
        chaseEmail: null,
        chasePhoneE164: null,
        fallback: { ...EMPTY, gcEmail: 'gc@x.com' },
      }),
    ).toBe('gc@x.com')
  })

  it('only returns "Unknown" when there is genuinely nothing anywhere', () => {
    expect(
      composeCaseName({
        contactName: null,
        personName: null,
        chaseEmail: null,
        chasePhoneE164: null,
        fallback: EMPTY,
      }),
    ).toBe('Unknown')
  })
})

type FakeDb = Parameters<typeof loadGcFallbackForCases>[0]

function makeDb(opts: {
  subs?: Array<{ gcSubscriptionId: string; name: string | null; gcCustomerId: string | null }>
  custs?: Array<{
    gcCustomerId: string
    givenName: string | null
    familyName: string | null
    companyName: string | null
    email: string | null
    phone: string | null
  }>
}): FakeDb {
  return {
    gcSubscription: {
      findMany: async ({ where }: { where: { gcSubscriptionId: { in: string[] } } }) =>
        (opts.subs ?? []).filter((s) => where.gcSubscriptionId.in.includes(s.gcSubscriptionId)),
    },
    gcCustomer: {
      findMany: async ({ where }: { where: { gcCustomerId: { in: string[] } } }) =>
        (opts.custs ?? []).filter((c) => where.gcCustomerId.in.includes(c.gcCustomerId)),
    },
  } as unknown as FakeDb
}

describe('loadGcFallbackForCases', () => {
  it('resolves the customer name/email directly from the case gcCustomerId', async () => {
    const db = makeDb({
      custs: [
        {
          gcCustomerId: 'CU1',
          givenName: 'Lamar',
          familyName: 'Fallatah',
          companyName: null,
          email: 'lamar@gc.example',
          phone: '+447700900321',
        },
      ],
    })
    const map = await loadGcFallbackForCases(db, [
      { id: 'case1', gcCustomerId: 'CU1', gcSubscriptionId: null },
    ])
    expect(map.get('case1')).toEqual({
      gcName: 'Lamar Fallatah',
      gcEmail: 'lamar@gc.example',
      gcPhone: '+447700900321',
      planName: null,
    })
  })

  it('resolves the customer VIA the subscription when the case has no gcCustomerId, and carries the plan name', async () => {
    const db = makeDb({
      subs: [{ gcSubscriptionId: 'SUB1', name: 'Ilona Pisarek 30h LNAT', gcCustomerId: 'CU2' }],
      custs: [
        {
          gcCustomerId: 'CU2',
          givenName: 'Ilona',
          familyName: 'Pisarek',
          companyName: null,
          email: 'ilona@gc.example',
          phone: null,
        },
      ],
    })
    const map = await loadGcFallbackForCases(db, [
      { id: 'case2', gcCustomerId: null, gcSubscriptionId: 'SUB1' },
    ])
    expect(map.get('case2')).toEqual({
      gcName: 'Ilona Pisarek',
      gcEmail: 'ilona@gc.example',
      gcPhone: null,
      planName: 'Ilona Pisarek 30h LNAT',
    })
  })

  it('still returns the plan name when the customer record is missing entirely', async () => {
    const db = makeDb({
      subs: [{ gcSubscriptionId: 'SUB3', name: 'Yasmin Ali 30h', gcCustomerId: null }],
    })
    const map = await loadGcFallbackForCases(db, [
      { id: 'case3', gcCustomerId: null, gcSubscriptionId: 'SUB3' },
    ])
    expect(map.get('case3')).toEqual({
      gcName: null,
      gcEmail: null,
      gcPhone: null,
      planName: 'Yasmin Ali 30h',
    })
  })
})
