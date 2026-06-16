import { describe, expect, it } from 'vitest'

import {
  extractIdentifiersFromText,
  matchContactByCandidate,
  phoneVariants,
  type MatchDb,
} from './match-candidate'

interface Row {
  id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
  deletedAt: Date | null
}

type Cond = { firstName?: { equals: string }; lastName?: { equals: string } }

function matchesNameCond(r: Row, cond: Cond): boolean {
  if (cond.firstName && (r.firstName ?? '').toLowerCase() !== cond.firstName.equals.toLowerCase()) {
    return false
  }
  if (cond.lastName && (r.lastName ?? '').toLowerCase() !== cond.lastName.equals.toLowerCase()) {
    return false
  }
  return Boolean(cond.firstName || cond.lastName)
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
          if (first && (r.firstName ?? '').toLowerCase() !== first.equals.toLowerCase())
            return false
          const last = where['lastName'] as { equals: string } | undefined
          if (last && (r.lastName ?? '').toLowerCase() !== last.equals.toLowerCase()) return false
          const or = where['OR'] as Cond[] | undefined
          if (or && !or.some((c) => matchesNameCond(r, c))) return false
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

describe('extractIdentifiersFromText', () => {
  it('pulls an email and phone out of a free-text summary', () => {
    const r = extractIdentifiersFromText('Spoke to Jane on 07700 900123, email jane@example.com')
    expect(r.email).toBe('jane@example.com')
    expect(r.phone?.replace(/[^\d]/gu, '')).toBe('07700900123'.replace(/[^\d]/gu, ''))
  })
  it('returns nulls when nothing identifiable is present', () => {
    expect(extractIdentifiersFromText('Had a nice chat about maths')).toEqual({
      email: null,
      phone: null,
    })
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
  it('parks an ambiguous name (two Jane Smiths)', async () => {
    const r = await matchContactByCandidate(fakeDb([jane, otherJane]), { name: 'Jane Smith' })
    expect(r).toMatchObject({ contactId: null, reason: 'ambiguous' })
  })
  it('auto-attaches an unambiguous single-token first name', async () => {
    const r = await matchContactByCandidate(fakeDb([jane]), { name: 'Jane' })
    expect(r).toMatchObject({ contactId: 'c1', via: 'name', reason: 'matched' })
  })
  it('auto-attaches an unambiguous single-token surname', async () => {
    const r = await matchContactByCandidate(fakeDb([jane]), { name: 'Smith' })
    expect(r).toMatchObject({ contactId: 'c1', via: 'name', reason: 'matched' })
  })
  it('parks an ambiguous single-token name (two Janes)', async () => {
    const r = await matchContactByCandidate(fakeDb([jane, otherJane]), { name: 'Jane' })
    expect(r).toMatchObject({ contactId: null, reason: 'ambiguous' })
  })
  it('matches a full name held in a single column', async () => {
    const fullInFirst: Row = { ...jane, id: 'c9', firstName: 'Jane Smith', lastName: null }
    const r = await matchContactByCandidate(fakeDb([fullInFirst]), { name: 'Jane Smith' })
    expect(r).toMatchObject({ contactId: 'c9', via: 'name', reason: 'matched' })
  })
  it('reports no_candidate when nothing was provided', async () => {
    const r = await matchContactByCandidate(fakeDb([jane]), {})
    expect(r).toMatchObject({ contactId: null, reason: 'no_candidate' })
  })
})
