import { describe, expect, it } from 'vitest'

import {
  parseStructuredComplaint,
  structuredComplaintDescription,
  structuredComplaintTitle,
} from './complaint-parse'

// The real #complaintcallsummaries format (from the team's Slack).
const SAMPLE = `Client Name and Number: Vyshale Arulalagan - UCAT (+1 (647) 901-2817)
Guardian Name and Number: Mekala Ganeshamoorthy (+16479618338)
Client Email: vyvarul@gmail.com
Hours Booked: 30h each
Hours Remaining: 27h
Amount Paid: (inc. instalment details if applicable) £1082
Complaint:
• Parent, Mekala is unhappy about finding a consistent schedule during the weekends for lesson
• Laiba M is their 2nd tutor after Maria A.
• Today was their first lesson but Laiba was feeling unwell - unfortunate but can't be helped
• Parent is frustrated because of this and requests a tutor who has more consistent availability
• The are from Canada
Suggested Solution: Offer 1h free as an apology
Actions: Find a 2nd tutor who can help with schedule and ensure they can accommodate weekends/timezone difference to avoid parent/student from being more upset`

describe('parseStructuredComplaint', () => {
  it('extracts the client identity for matching', () => {
    const s = parseStructuredComplaint(SAMPLE)
    expect(s).not.toBeNull()
    expect(s!.clientName).toBe('Vyshale Arulalagan')
    expect(s!.clientEmail).toBe('vyvarul@gmail.com')
    expect(s!.clientPhone?.replace(/\D/gu, '')).toBe('16479012817')
    expect(s!.guardianName).toBe('Mekala Ganeshamoorthy')
    expect(s!.guardianPhone?.replace(/\D/gu, '')).toBe('16479618338')
  })

  it('extracts the complaint narrative + solution + actions separately', () => {
    const s = parseStructuredComplaint(SAMPLE)!
    expect(s.complaint).toContain('unhappy about finding a consistent schedule')
    expect(s.complaint).toContain('requests a tutor who has more consistent availability')
    // Narrative must NOT bleed into the solution/actions.
    expect(s.complaint).not.toContain('Offer 1h free')
    expect(s.suggestedSolution).toBe('Offer 1h free as an apology')
    expect(s.actions).toContain('Find a 2nd tutor who can help with schedule')
  })

  it('keeps the context figures', () => {
    const s = parseStructuredComplaint(SAMPLE)!
    expect(s.hoursBooked).toBe('30h each')
    expect(s.hoursRemaining).toBe('27h')
    expect(s.amountPaid).toContain('£1082')
  })

  it('builds a clean title and structured description', () => {
    const s = parseStructuredComplaint(SAMPLE)!
    expect(structuredComplaintTitle(s)).toBe('Complaint — Vyshale Arulalagan')
    const desc = structuredComplaintDescription(s)
    // Narrative first, then the labelled sections + client/context details.
    expect(desc.indexOf('unhappy about finding a consistent schedule')).toBeLessThan(
      desc.indexOf('Suggested solution:'),
    )
    expect(desc).toContain('Suggested solution: Offer 1h free as an apology')
    expect(desc).toContain('Actions: Find a 2nd tutor')
    expect(desc).toContain('Client: Vyshale Arulalagan · vyvarul@gmail.com')
    expect(desc).toContain('Guardian: Mekala Ganeshamoorthy')
  })

  it('tolerates bold labels and CRLF', () => {
    const s = parseStructuredComplaint(
      '*Client Email:* a@b.com\r\n*Complaint:* it broke\r\n*Actions:* fix it',
    )
    expect(s).not.toBeNull()
    expect(s!.clientEmail).toBe('a@b.com')
    expect(s!.complaint).toBe('it broke')
    expect(s!.actions).toBe('fix it')
  })

  it('returns null for unstructured prose (falls back to plain draft)', () => {
    expect(parseStructuredComplaint('Spoke to Aanya Sharma, she is unhappy about the mocks')).toBeNull()
    expect(parseStructuredComplaint('Just one line: hello')).toBeNull()
  })
})
