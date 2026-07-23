import { describe, expect, it } from 'vitest'

import { scheduledCallFromLead } from './backfill-call-times'

describe('scheduledCallFromLead', () => {
  it('parses "Call day" + "Call time" relative to the submission date', () => {
    const raw = { fields: { 'call-day': 'Friday 24 Jul', 'call-time': '10:00-10:30' } }
    const when = scheduledCallFromLead(raw, new Date('2026-07-23T09:00:00Z'))
    // 24 Jul 2026 is in BST (UTC+1), so 10:00 London == 09:00 UTC.
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
