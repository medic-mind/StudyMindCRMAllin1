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
    expect(d).toEqual({ contactId: 'c1', reason: 'matched by email', ambiguous: false })
  })

  it('refuses to guess when several contacts share an email', () => {
    const d = chooseContactMatch({
      email: 'a@b.com',
      phoneE164: null,
      byEmail: [{ id: 'c1' }, { id: 'c2' }],
      byPhone: [],
    })
    expect(d.contactId).toBeNull()
    expect(d.ambiguous).toBe(true)
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

  it('treats a shared family line as no confident match', () => {
    const d = chooseContactMatch({
      email: null,
      phoneE164: '+447123456789',
      byEmail: [],
      byPhone: [{ id: 'c1' }, { id: 'c2' }],
    })
    expect(d.contactId).toBeNull()
    expect(d.ambiguous).toBe(true)
  })

  it('returns no match when nothing is found', () => {
    const d = chooseContactMatch({ email: 'a@b.com', phoneE164: null, byEmail: [], byPhone: [] })
    expect(d).toEqual({ contactId: null, reason: 'no existing contact matched', ambiguous: false })
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
  const noMatch = { contactId: null, reason: 'no existing contact matched', ambiguous: false }

  it('onboards a brand-new contactable lead', () => {
    const plan = planLeadRouting({ hasContactInfo: true, match: noMatch, lastEnquiryAt: null, now })
    expect(plan).toEqual({ kind: 'onboard' })
  })

  it('sends a lead with no email or phone to triage', () => {
    const plan = planLeadRouting({
      hasContactInfo: false,
      match: noMatch,
      lastEnquiryAt: null,
      now,
    })
    expect(plan.kind).toBe('needs_triage')
  })

  it('sends an ambiguous match to triage rather than guessing', () => {
    const plan = planLeadRouting({
      hasContactInfo: true,
      match: { contactId: null, reason: 'shared line', ambiguous: true },
      lastEnquiryAt: null,
      now,
    })
    expect(plan.kind).toBe('needs_triage')
  })

  it('annotates only on a re-enquiry within 24h', () => {
    const plan = planLeadRouting({
      hasContactInfo: true,
      match: { contactId: 'c1', reason: 'email', ambiguous: false },
      lastEnquiryAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      now,
    })
    expect(plan).toEqual({ kind: 'reenquiry', contactId: 'c1', createCard: false })
  })

  it('adds a fresh card on a re-enquiry after 24h', () => {
    const plan = planLeadRouting({
      hasContactInfo: true,
      match: { contactId: 'c1', reason: 'email', ambiguous: false },
      lastEnquiryAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      now,
    })
    expect(plan).toEqual({ kind: 'reenquiry', contactId: 'c1', createCard: true })
  })
})
