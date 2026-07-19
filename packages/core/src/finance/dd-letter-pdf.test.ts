import { describe, expect, it } from 'vitest'

import { renderRecoveryLetterPdf } from './dd-letter-pdf'

describe('renderRecoveryLetterPdf', () => {
  it('produces a non-empty PDF buffer', () => {
    const pdf = renderRecoveryLetterPdf({
      subject: 'Letter before claim — outstanding balance of £800.00',
      body: 'Dear Jane,\n\nYour balance of £800.00 is overdue.\n\nYours sincerely,\nMedic Mind',
    })
    expect(pdf.length).toBeGreaterThan(200)
    // Valid PDFs begin with the %PDF- header and end with %%EOF.
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(pdf.toString('latin1')).toContain('%%EOF')
  })

  it('handles a long multi-paragraph letter (paginates without throwing)', () => {
    const body = Array.from({ length: 80 }, (_, i) => `Paragraph ${i} with some text.`).join('\n\n')
    const pdf = renderRecoveryLetterPdf({ subject: 'Notice', body })
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })
})
