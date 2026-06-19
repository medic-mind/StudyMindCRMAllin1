import { describe, expect, it } from 'vitest'

import {
  extractIdentifiersFromText,
  matchBusinessAccountByCandidate,
  matchContactByCandidate,
  phoneVariants,
  type MatchAccountDb,
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

type NameCol = { equals?: string; startsWith?: string }
type Cond = { firstName?: NameCol; lastName?: NameCol }

function colMatches(value: string | null, col: NameCol | undefined): boolean {
  if (!col) return false
  const v = (value ?? '').toLowerCase()
  if (col.equals !== undefined) return v === col.equals.toLowerCase()
  if (col.startsWith !== undefined) return v.startsWith(col.startsWith.toLowerCase())
  return false
}

function matchesNameCond(r: Row, cond: Cond): boolean {
  if (cond.firstName) return colMatches(r.firstName, cond.firstName)
  if (cond.lastName) return colMatches(r.lastName, cond.lastName)
  return false
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

  // Fuzzy pass is OPT-IN — default (exact) must NOT match a nickname/prefix.
  it('does NOT match a nickname by default (exact only)', async () => {
    const jonathan: Row = { ...jane, id: 'cj', firstName: 'Jonathan', lastName: 'Doe' }
    const r = await matchContactByCandidate(fakeDb([jonathan]), { name: 'Jon Doe' })
    expect(r.contactId).toBeNull()
  })

  it('matches a nickname when fuzzy is enabled (Jon → Jonathan)', async () => {
    const jonathan: Row = { ...jane, id: 'cj', firstName: 'Jonathan', lastName: 'Doe' }
    const r = await matchContactByCandidate(fakeDb([jonathan]), { name: 'Jon Doe' }, { fuzzy: true })
    expect(r).toMatchObject({ contactId: 'cj', via: 'name', reason: 'matched', fuzzy: true })
  })

  it('fuzzy matches a first-name prefix unambiguously (Bartho → Bartholomew)', async () => {
    const bart: Row = { ...jane, id: 'cb', firstName: 'Bartholomew', lastName: 'Reed' }
    const r = await matchContactByCandidate(
      fakeDb([bart]),
      { name: 'Bartho Reed' },
      { fuzzy: true },
    )
    expect(r).toMatchObject({ contactId: 'cb', reason: 'matched', fuzzy: true })
  })

  it('fuzzy still refuses to guess between two candidates', async () => {
    const a: Row = { ...jane, id: 'a', firstName: 'Jonathan', lastName: 'Doe' }
    const b: Row = { ...jane, id: 'b', firstName: 'Jonny', lastName: 'Doe' }
    const r = await matchContactByCandidate(fakeDb([a, b]), { name: 'Jon Doe' }, { fuzzy: true })
    expect(r).toMatchObject({ contactId: null, reason: 'ambiguous' })
  })
})

// ---------------------------------------------------------------------------
// B2B account matcher (schools / partnerships)
// ---------------------------------------------------------------------------

interface AccountRow {
  id: string
  name: string
  contactEmail: string | null
  contactPhone: string | null
  website: string | null
  archivedAt: Date | null
}

function fakeAccountDb(rows: AccountRow[]): MatchAccountDb {
  const insens = (a: string | null, b: string) => (a ?? '').toLowerCase() === b.toLowerCase()
  return {
    businessAccount: {
      async findMany({ where, take }) {
        const matches = rows.filter((r) => {
          if (r.archivedAt) return false
          const email = where['contactEmail'] as
            | { equals?: string; endsWith?: string }
            | undefined
          if (email?.equals && !insens(r.contactEmail, email.equals)) return false
          if (email?.endsWith && !(r.contactEmail ?? '').toLowerCase().endsWith(email.endsWith.toLowerCase()))
            return false
          const phone = where['contactPhone'] as { in?: string[]; contains?: string } | undefined
          if (phone?.in && !phone.in.includes(r.contactPhone ?? '')) return false
          if (phone?.contains && !(r.contactPhone ?? '').includes(phone.contains)) return false
          const name = where['name'] as { equals?: string; contains?: string } | undefined
          if (name?.equals && !insens(r.name, name.equals)) return false
          if (name?.contains && !r.name.toLowerCase().includes(name.contains.toLowerCase()))
            return false
          const or = where['OR'] as Array<Record<string, { endsWith?: string; contains?: string }>>
            | undefined
          if (or) {
            const any = or.some((c) => {
              const ce = c['contactEmail']
              if (ce?.endsWith && (r.contactEmail ?? '').toLowerCase().endsWith(ce.endsWith.toLowerCase()))
                return true
              const w = c['website']
              if (w?.contains && (r.website ?? '').toLowerCase().includes(w.contains.toLowerCase()))
                return true
              return false
            })
            if (!any) return false
          }
          return true
        })
        return matches.slice(0, take).map((r) => ({ id: r.id }))
      },
    },
  }
}

const oakwood: AccountRow = {
  id: 'a1',
  name: 'Oakwood Primary',
  contactEmail: 'office@oakwood.sch.uk',
  contactPhone: '+441234567890',
  website: 'https://oakwood.sch.uk',
  archivedAt: null,
}

describe('matchBusinessAccountByCandidate', () => {
  it('matches a school by its exact org email', async () => {
    const r = await matchBusinessAccountByCandidate(fakeAccountDb([oakwood]), {
      email: 'OFFICE@oakwood.sch.uk',
    })
    expect(r).toMatchObject({ businessAccountId: 'a1', via: 'email', reason: 'matched' })
  })

  it('matches a school by email DOMAIN (sender at the org)', async () => {
    const r = await matchBusinessAccountByCandidate(fakeAccountDb([oakwood]), {
      email: 'jane.head@oakwood.sch.uk',
    })
    expect(r).toMatchObject({ businessAccountId: 'a1', via: 'email_domain', reason: 'matched' })
  })

  it('never domain-matches on free webmail', async () => {
    const gmailAccount: AccountRow = { ...oakwood, contactEmail: 'someone@gmail.com', website: null }
    const r = await matchBusinessAccountByCandidate(fakeAccountDb([gmailAccount]), {
      email: 'other@gmail.com',
    })
    expect(r.businessAccountId).toBeNull()
  })

  it('matches by phone variants', async () => {
    const r = await matchBusinessAccountByCandidate(fakeAccountDb([oakwood]), {
      phone: '01234 567890',
    })
    expect(r).toMatchObject({ businessAccountId: 'a1', via: 'phone' })
  })

  it('matches by exact org name (case-insensitive)', async () => {
    const r = await matchBusinessAccountByCandidate(fakeAccountDb([oakwood]), {
      name: 'oakwood primary',
    })
    expect(r).toMatchObject({ businessAccountId: 'a1', via: 'name', reason: 'matched' })
  })

  it('parks an ambiguous domain (two accounts share it)', async () => {
    const sister: AccountRow = { ...oakwood, id: 'a2', contactEmail: 'admin@oakwood.sch.uk' }
    const r = await matchBusinessAccountByCandidate(fakeAccountDb([oakwood, sister]), {
      email: 'teacher@oakwood.sch.uk',
    })
    expect(r).toMatchObject({ businessAccountId: null, reason: 'ambiguous' })
  })

  it('reports no_candidate when nothing was provided', async () => {
    const r = await matchBusinessAccountByCandidate(fakeAccountDb([oakwood]), {})
    expect(r).toMatchObject({ businessAccountId: null, reason: 'no_candidate' })
  })

  it('does NOT partial-match a name unless fuzzy is enabled', async () => {
    const r = await matchBusinessAccountByCandidate(fakeAccountDb([oakwood]), { name: 'Oakwood' })
    expect(r.businessAccountId).toBeNull()
  })

  it('fuzzy partial-matches an org name (Oakwood → Oakwood Primary)', async () => {
    const r = await matchBusinessAccountByCandidate(
      fakeAccountDb([oakwood]),
      { name: 'Oakwood' },
      { fuzzy: true },
    )
    expect(r).toMatchObject({ businessAccountId: 'a1', via: 'name', reason: 'matched', fuzzy: true })
  })
})
