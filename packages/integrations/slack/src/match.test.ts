import { describe, expect, it } from 'vitest'

import { matchContactByCandidate, phoneVariants, type MatchDb } from './match'

interface Row {
  id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
  deletedAt: Date | null
}

function fakeDb(rows: Row[]): MatchDb {
  return {
    contact: {
      async findMany({ where, take }) {
        const matches = rows.filter((r) => {
          if (r.deletedAt) return false
          const email = where['email'] as { equals: string } | undefined
          if (email && (r.email ?? '').toLowerCase() !== email.equals.toLowerCase()) return false
          const phone = where['phoneE164'] as { in?: string[]; endsWith?: string } | undefined
          if (phone?.in && !phone.in.includes(r.phoneE164 ?? '')) return false
          if (phone?.endsWith && !(r.phoneE164 ?? '').endsWith(phone.endsWith)) return false
          const first = where['firstName'] as { equals: string } | undefined
          if (first && (r.firstName ?? '').toLowerCase() !== first.equals.toLowerCase()) return false
          const last = where['lastName'] as { equals: string } | undefined
          if (last && (r.lastName ?? '').toLowerCase() !== last.equals.toLowerCase()) return false
          return true
        })
        return matches.slice(0, take).map((r) => ({ id: r.id }))
      },
    },
  }
}

const jane: Row = {
  id: 'c1',
  firstName: 'Jane',
  lastName: 'Smith',
  email: 'jane@example.com',
  phoneE164: '+447700900123',
  deletedAt: null,
}
const otherJane: Row = { ...jane, id: 'c2', email: 'jane2@example.com', phoneE164: '+447700900999' }

describe('phoneVariants', () => {
  it('normalises UK national, 00-prefix, bare dial code and E.164', () => {
    expect(phoneVariants('07700 900123')).toContain('+447700900123')
    expect(phoneVariants('0044 7700 900123')).toContain('+447700900123')
    expect(phoneVariants('44 7700 900 123')).toContain('+447700900123')
    expect(phoneVariants('+44 7700 900123')).toContain('+447700900123')
  })
})

describe('matchContactByCandidate', () => {
  it('matches by email first', async () => {
    const r = await matchContactByCandidate(fakeDb([jane]), { email: 'JANE@example.com' })
    expect(r).toMatchObject({ contactId: 'c1', via: 'email', reason: 'matched' })
  })

  it('matches a nationally-typed phone number', async () => {
    const r = await matchContactByCandidate(fakeDb([jane]), { phone: '07700 900123' })
    expect(r).toMatchObject({ contactId: 'c1', via: 'phone' })
  })

  it('matches an unambiguous full name (case-insensitive)', async () => {
    const r = await matchContactByCandidate(fakeDb([jane]), { name: 'jane smith' })
    expect(r).toMatchObject({ contactId: 'c1', via: 'name', reason: 'matched' })
  })

  it('parks an ambiguous name (two Jane Smiths) instead of guessing', async () => {
    const r = await matchContactByCandidate(fakeDb([jane, otherJane]), { name: 'Jane Smith' })
    expect(r).toMatchObject({ contactId: null, reason: 'ambiguous' })
  })

  it('never auto-attaches a single-token name', async () => {
    const r = await matchContactByCandidate(fakeDb([jane]), { name: 'Jane' })
    expect(r).toMatchObject({ contactId: null, reason: 'no_match' })
  })

  it('email beats a name pointing elsewhere', async () => {
    const r = await matchContactByCandidate(fakeDb([jane, otherJane]), {
      email: 'jane2@example.com',
      name: 'Jane Smith',
    })
    expect(r).toMatchObject({ contactId: 'c2', via: 'email' })
  })

  it('reports no_candidate when the AI extracted nothing', async () => {
    const r = await matchContactByCandidate(fakeDb([jane]), {})
    expect(r).toMatchObject({ contactId: null, reason: 'no_candidate' })
  })
})
