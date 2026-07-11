import { beforeEach, describe, expect, it, vi } from 'vitest'

const { matchContact, matchAccount, baFindFirst } = vi.hoisted(() => ({
  matchContact: vi.fn(),
  matchAccount: vi.fn(),
  baFindFirst: vi.fn(),
}))

vi.mock('./match', () => ({
  matchContactByCandidate: matchContact,
  matchBusinessAccountByCandidate: matchAccount,
}))

vi.mock('@studymind/db', () => ({
  db: { businessAccountContact: { findFirst: baFindFirst } },
}))

import {
  resolveSlackLinkTarget,
  resolveSlackLinkTargetFromNames,
  targetAuditTarget,
  targetForeignKey,
} from './link-target'

beforeEach(() => {
  matchContact.mockReset()
  matchAccount.mockReset()
  baFindFirst.mockReset()
})

describe('resolveSlackLinkTarget', () => {
  it('stamps a matched contact AND its school (so it shows on both)', async () => {
    matchContact.mockResolvedValue({ contactId: 'c1', via: 'email', reason: 'matched' })
    baFindFirst.mockResolvedValue({ accountId: 'a1' })

    const t = await resolveSlackLinkTarget({ email: 'jane@oakwood.sch.uk' })
    expect(t).toEqual({
      kind: 'contact',
      contactId: 'c1',
      businessAccountId: 'a1',
      via: 'email',
    })
    // Account matcher is never consulted once a person matched.
    expect(matchAccount).not.toHaveBeenCalled()
  })

  it('stamps a contact with no school as contact-only', async () => {
    matchContact.mockResolvedValue({ contactId: 'c2', via: 'phone', reason: 'matched' })
    baFindFirst.mockResolvedValue(null)

    const t = await resolveSlackLinkTarget({ phone: '07700 900123' })
    expect(t).toEqual({ kind: 'contact', contactId: 'c2', via: 'phone' })
  })

  it('falls back to the B2B account when no person matches (org-only mention)', async () => {
    matchContact.mockResolvedValue({ contactId: null, via: null, reason: 'no_match' })
    matchAccount.mockResolvedValue({
      businessAccountId: 'a9',
      via: 'email_domain',
      reason: 'matched',
    })

    const t = await resolveSlackLinkTarget({ email: 'office@oakwood.sch.uk' })
    expect(t).toEqual({ kind: 'account', businessAccountId: 'a9', via: 'email_domain' })
  })

  it('returns null when neither a contact nor an account resolves', async () => {
    matchContact.mockResolvedValue({ contactId: null, via: null, reason: 'no_match' })
    matchAccount.mockResolvedValue({ businessAccountId: null, via: null, reason: 'no_match' })
    expect(await resolveSlackLinkTarget({ name: 'Nobody Known' })).toBeNull()
  })
})

describe('resolveSlackLinkTargetFromNames', () => {
  it('links when exactly one candidate resolves (name-only, no AI)', async () => {
    matchContact.mockImplementation(async (_db: unknown, cand: { name?: string | null }) =>
      cand.name === 'Aanya Sharma'
        ? { contactId: 'c1', via: 'name', reason: 'matched' }
        : { contactId: null, via: null, reason: 'no_match' },
    )
    matchAccount.mockResolvedValue({ businessAccountId: null, via: null, reason: 'no_match' })
    baFindFirst.mockResolvedValue(null)

    const t = await resolveSlackLinkTargetFromNames(['Aanya Sharma', 'Monday'])
    expect(t).toEqual({ kind: 'contact', contactId: 'c1', via: 'name' })
  })

  it('parks (null) when two candidates resolve to two DIFFERENT contacts', async () => {
    matchContact.mockImplementation(async (_db: unknown, cand: { name?: string | null }) => {
      if (cand.name === 'Aanya Sharma')
        return { contactId: 'c1', via: 'name', reason: 'matched' }
      if (cand.name === 'Leisha Burgess')
        return { contactId: 'c2', via: 'name', reason: 'matched' }
      return { contactId: null, via: null, reason: 'no_match' }
    })
    matchAccount.mockResolvedValue({ businessAccountId: null, via: null, reason: 'no_match' })
    baFindFirst.mockResolvedValue(null)

    expect(
      await resolveSlackLinkTargetFromNames(['Aanya Sharma', 'Leisha Burgess']),
    ).toBeNull()
  })

  it('a person + their OWN school is consistent — keeps the contact target', async () => {
    matchContact.mockImplementation(async (_db: unknown, cand: { name?: string | null }) =>
      cand.name === 'Aanya Sharma'
        ? { contactId: 'c1', via: 'name', reason: 'matched' }
        : { contactId: null, via: null, reason: 'no_match' },
    )
    matchAccount.mockImplementation(async (_db: unknown, cand: { name?: string | null }) =>
      cand.name === 'Oakwood Primary'
        ? { businessAccountId: 'a1', via: 'name', reason: 'matched' }
        : { businessAccountId: null, via: null, reason: 'no_match' },
    )
    baFindFirst.mockResolvedValue({ accountId: 'a1' }) // Aanya belongs to a1

    const t = await resolveSlackLinkTargetFromNames(['Aanya Sharma', 'Oakwood Primary'])
    expect(t).toEqual({
      kind: 'contact',
      contactId: 'c1',
      businessAccountId: 'a1',
      via: 'name',
    })
  })

  it('a person + an UNRELATED school is ambiguous — parks (null)', async () => {
    matchContact.mockImplementation(async (_db: unknown, cand: { name?: string | null }) =>
      cand.name === 'Aanya Sharma'
        ? { contactId: 'c1', via: 'name', reason: 'matched' }
        : { contactId: null, via: null, reason: 'no_match' },
    )
    matchAccount.mockImplementation(async (_db: unknown, cand: { name?: string | null }) =>
      cand.name === 'Elm Grove'
        ? { businessAccountId: 'a9', via: 'name', reason: 'matched' }
        : { businessAccountId: null, via: null, reason: 'no_match' },
    )
    baFindFirst.mockResolvedValue(null) // Aanya belongs to no school

    expect(await resolveSlackLinkTargetFromNames(['Aanya Sharma', 'Elm Grove'])).toBeNull()
  })

  it('returns null when nothing resolves (empty list, or no matches)', async () => {
    matchContact.mockResolvedValue({ contactId: null, via: null, reason: 'no_match' })
    matchAccount.mockResolvedValue({ businessAccountId: null, via: null, reason: 'no_match' })
    expect(await resolveSlackLinkTargetFromNames([])).toBeNull()
    expect(await resolveSlackLinkTargetFromNames(['Nobody Known'])).toBeNull()
  })
})

describe('targetForeignKey', () => {
  it('emits both keys when a contact carries a school', () => {
    expect(
      targetForeignKey({ kind: 'contact', contactId: 'c1', businessAccountId: 'a1', via: 'email' }),
    ).toEqual({ contactId: 'c1', businessAccountId: 'a1' })
  })
  it('emits only the account key for an org-only mention', () => {
    expect(targetForeignKey({ kind: 'account', businessAccountId: 'a1', via: 'name' })).toEqual({
      businessAccountId: 'a1',
    })
  })
})

describe('targetAuditTarget', () => {
  it('prefers the Contact as the primary audit entity', () => {
    expect(
      targetAuditTarget({ kind: 'contact', contactId: 'c1', businessAccountId: 'a1', via: 'email' }),
    ).toEqual({ type: 'Contact', id: 'c1' })
  })
  it('targets the account for an org-only mention', () => {
    expect(targetAuditTarget({ kind: 'account', businessAccountId: 'a1', via: 'name' })).toEqual({
      type: 'BusinessAccount',
      id: 'a1',
    })
  })
})
