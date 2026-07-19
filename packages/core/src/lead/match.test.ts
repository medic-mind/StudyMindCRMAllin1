import { describe, expect, it } from 'vitest'

import { chooseContactMatch, planLeadRouting, shouldCreateCardOnReenquiry } from './match'

describe('chooseContactMatch', () => {
  it('matches a single email hit', () => {
    const d = chooseContactMatch({
      email: 'a@b.com',
      phoneE164: null,
      byEmail: [{ id: 'c1' }],
      byPhone: [],
    })
    expect(d).toEqual({ contactId: 'c1', reason: 'matched by email', ambiguousResolved: false })
  })

  it('attaches a shared email to the most recently active contact (ADR 0044)', () => {
    const d = chooseContactMatch({
      email: 'a@b.com',
      phoneE164: null,
      byEmail: [{ id: 'c-recent' }, { id: 'c-stale' }],
      byPhone: [],
    })
    expect(d.contactId).toBe('c-recent')
    expect(d.ambiguousResolved).toBe(true)
  })

  it('falls back to a single phone match', () => {
    const d = chooseContactMatch({
      email: null,
      phoneE164: '+447123456789',
      byEmail: [],
      byPhone: [{ id: 'c9' }],
    })
    expect(d.contactId).toBe('c9')
  })

  it('attaches a shared family line to the most recently active contact', () => {
    const d = chooseContactMatch({
      email: null,
      phoneE164: '+447123456789',
      byEmail: [],
      byPhone: [{ id: 'c-recent' }, { id: 'c-stale' }],
    })
    expect(d.contactId).toBe('c-recent')
    expect(d.ambiguousResolved).toBe(true)
  })

  it('attaches a UNIQUE name match when there is no email/phone', () => {
    const d = chooseContactMatch({
      email: null,
      phoneE164: null,
      byEmail: [],
      byPhone: [],
      byName: [{ id: 'c3' }],
    })
    expect(d).toEqual({ contactId: 'c3', reason: 'matched by name', ambiguousResolved: false })
  })

  it('never attaches an ambiguous name — two Jane Smiths create a fresh contact', () => {
    const d = chooseContactMatch({
      email: null,
      phoneE164: null,
      byEmail: [],
      byPhone: [],
      byName: [{ id: 'c1' }, { id: 'c2' }],
    })
    expect(d.contactId).toBeNull()
    expect(d.ambiguousResolved).toBe(false)
  })

  it('returns no match when nothing is found', () => {
    const d = chooseContactMatch({ email: 'a@b.com', phoneE164: null, byEmail: [], byPhone: [] })
    expect(d).toEqual({
      contactId: null,
      reason: 'no existing contact matched',
      ambiguousResolved: false,
    })
  })
})

describe('shouldCreateCardOnReenquiry', () => {
  const now = new Date('2026-05-30T12:00:00Z')

  it('creates a card when there is no prior enquiry', () => {
    expect(shouldCreateCardOnReenquiry(null, now)).toBe(true)
  })

  it('suppresses a new card within the 24h window (anti-spam)', () => {
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000)
    expect(shouldCreateCardOnReenquiry(twoHoursAgo, now)).toBe(false)
  })

  it('resurfaces a card for renewed interest after 24h', () => {
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
    expect(shouldCreateCardOnReenquiry(threeDaysAgo, now)).toBe(true)
  })
})

describe('planLeadRouting', () => {
  const now = new Date('2026-05-30T12:00:00Z')
  const noMatch = {
    contactId: null,
    reason: 'no existing contact matched',
    ambiguousResolved: false,
  }

  it('onboards a brand-new contactable lead', () => {
    const plan = planLeadRouting({
      hasContactInfo: true,
      hasName: true,
      match: noMatch,
      lastEnquiryAt: null,
      now,
    })
    expect(plan).toEqual({ kind: 'onboard' })
  })

  it('onboards a name-only lead — no tray, no dead end (ADR 0044)', () => {
    const plan = planLeadRouting({
      hasContactInfo: false,
      hasName: true,
      match: noMatch,
      lastEnquiryAt: null,
      now,
    })
    expect(plan).toEqual({ kind: 'onboard' })
  })

  it('discards junk with no name, email or phone', () => {
    const plan = planLeadRouting({
      hasContactInfo: false,
      hasName: false,
      match: noMatch,
      lastEnquiryAt: null,
      now,
    })
    expect(plan.kind).toBe('discard')
  })

  it('treats an auto-resolved ambiguous match as a re-enquiry, flagged', () => {
    const plan = planLeadRouting({
      hasContactInfo: true,
      hasName: true,
      match: { contactId: 'c1', reason: 'shared line', ambiguousResolved: true },
      lastEnquiryAt: null,
      now,
    })
    expect(plan).toEqual({
      kind: 'reenquiry',
      contactId: 'c1',
      createCard: true,
      ambiguousResolved: true,
    })
  })

  it('annotates only on a re-enquiry within 24h', () => {
    const plan = planLeadRouting({
      hasContactInfo: true,
      hasName: true,
      match: { contactId: 'c1', reason: 'email', ambiguousResolved: false },
      lastEnquiryAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      now,
    })
    expect(plan).toEqual({
      kind: 'reenquiry',
      contactId: 'c1',
      createCard: false,
      ambiguousResolved: false,
    })
  })

  it('adds a fresh card on a re-enquiry after 24h', () => {
    const plan = planLeadRouting({
      hasContactInfo: true,
      hasName: true,
      match: { contactId: 'c1', reason: 'email', ambiguousResolved: false },
      lastEnquiryAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      now,
    })
    expect(plan).toEqual({
      kind: 'reenquiry',
      contactId: 'c1',
      createCard: true,
      ambiguousResolved: false,
    })
  })
})
