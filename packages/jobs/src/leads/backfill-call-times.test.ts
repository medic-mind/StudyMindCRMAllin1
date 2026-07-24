import { describe, expect, it } from 'vitest'

import { healWindowBounds, planCallTimeHeals, scheduledCallFromLead } from './backfill-call-times'

describe('scheduledCallFromLead', () => {
  it('parses "Call day" + "Call time" relative to the submission date', () => {
    const raw = { fields: { 'call-day': 'Friday 24 Jul', 'call-time': '10:00-10:30' } }
    const when = scheduledCallFromLead(raw, new Date('2026-07-23T09:00:00Z'))
    // 24 Jul 2026 is in BST (UTC+1), so 10:00 London == 09:00 UTC.
    expect(when?.toISOString()).toBe('2026-07-24T09:00:00.000Z')
  })

  // The real "Conditional Form Submission" that prompted this fix: the whole
  // Medic Mind Consultation payload as it arrives on /api/leads (raw CF7 field
  // names + the RAW national phone, NOT the mail-template's "+44…" display).
  // The card for this lead was blank because it was processed the day before
  // the parser shipped — the auto-heal re-parses it to exactly this instant.
  it('recovers the call time from the full Medic Mind Consultation payload', () => {
    const raw = {
      fields: {
        'text-618': 'Shamin Anari',
        'email-1': 'anarishamin@gmail.com',
        'tel-146': '07852 544479',
        'menu-282': '1-1 Tutoring',
        'menu-283': '0-5',
        'text-500': 'Same as the one I entered',
        'menu-284': 'Friday 24 Jul',
        'menu-285': '10:00-10:30',
        'checkbox-891': 'I am over 18',
        'text-990': 'https://www.medicmind.co.uk/ucat-tutoring/',
        'text-991': '172.70.90.145',
      },
    }
    // Submitted Wed 22 Jul 2026 — a year-less "Friday 24 Jul" resolves forward.
    const when = scheduledCallFromLead(raw, new Date('2026-07-22T11:50:00Z'))
    expect(when?.toISOString()).toBe('2026-07-24T09:00:00.000Z')
  })

  it('uses the submission date to infer a year-less date', () => {
    // Submitted in Dec 2025 → "5 January" is the coming Jan 2026.
    const raw = { fields: { 'call-day': '5 January', 'call-time': '2pm' } }
    const when = scheduledCallFromLead(raw, new Date('2025-12-20T09:00:00Z'))
    // 5 Jan 2026 is GMT (UTC+0), 14:00 London == 14:00 UTC.
    expect(when?.toISOString()).toBe('2026-01-05T14:00:00.000Z')
  })

  it('returns null when the payload carries no call time', () => {
    expect(
      scheduledCallFromLead({ fields: { name: 'Jo', email: 'jo@example.test' } }, new Date('2026-07-23T09:00:00Z')),
    ).toBeNull()
  })
})

describe('planCallTimeHeals', () => {
  const submitted = new Date('2026-07-22T11:50:00Z')
  const withCall = {
    cardId: 'card_a',
    createdAt: submitted,
    rawPayload: { fields: { 'call-day': 'Friday 24 Jul', 'call-time': '10:00-10:30' } },
  }
  const noCall = {
    cardId: 'card_b',
    createdAt: submitted,
    rawPayload: { fields: { name: 'Jo', email: 'jo@example.test' } },
  }

  it('writes only blank cards whose payload carries a parseable call time', () => {
    const writes = planCallTimeHeals([withCall, noCall], new Set(['card_a', 'card_b']))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.cardId).toBe('card_a')
    expect(writes[0]!.when.toISOString()).toBe('2026-07-24T09:00:00.000Z')
  })

  it('skips a card that is no longer blank (already has a scheduled call)', () => {
    // card_a is NOT in the blank set → already filled → skipped (idempotent).
    expect(planCallTimeHeals([withCall], new Set())).toEqual([])
  })

  it('skips a lead with no backing card', () => {
    expect(
      planCallTimeHeals([{ ...withCall, cardId: null }], new Set(['card_a'])),
    ).toEqual([])
  })
})

describe('healWindowBounds', () => {
  it('scans a recent window that ENDS at the parser go-live cutoff', () => {
    // Default cutoff is 2026-07-24: the heal only touches leads submitted before
    // the parser shipped, so it can never revert an agent-cleared modern card.
    const { gte, lt } = healWindowBounds(new Date('2026-07-24T13:00:00Z'))
    expect(lt.toISOString()).toBe('2026-07-24T00:00:00.000Z')
    // 90-day recency lower bound.
    expect(gte.toISOString()).toBe('2026-04-25T13:00:00.000Z')
    // Shamin (submitted 22 Jul 2026) falls inside [gte, lt) → healed.
    const shamin = new Date('2026-07-22T11:50:00Z')
    expect(shamin >= gte && shamin < lt).toBe(true)
    // A modern lead (created after the cutoff) is excluded → never auto-touched.
    const modern = new Date('2026-08-10T09:00:00Z')
    expect(modern < lt).toBe(false)
  })
})
