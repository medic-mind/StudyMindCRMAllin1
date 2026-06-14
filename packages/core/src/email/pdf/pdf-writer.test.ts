import { describe, expect, it } from 'vitest'

import { escapePdfText, renderBrandedReportPdf } from './pdf-writer'

describe('escapePdfText (no more "?")', () => {
  it('maps common Unicode punctuation to WinAnsi octals instead of "?"', () => {
    const out = escapePdfText('it’s a — dash • bullet £5 €10 … “quote”')
    expect(out).not.toContain('?')
    expect(out).toContain('\\222') // ’  0x92
    expect(out).toContain('\\227') // —  0x97
    expect(out).toContain('\\225') // •  0x95
    expect(out).toContain('\\243') // £  0xA3 (Latin-1)
    expect(out).toContain('\\200') // €  0x80
    expect(out).toContain('\\205') // …  0x85
    expect(out).toContain('\\223') // “  0x93
  })

  it('passes ASCII through and escapes PDF delimiters', () => {
    expect(escapePdfText('Plain (text) \\ ok')).toBe('Plain \\(text\\) \\\\ ok')
  })

  it('only falls back to "?" for characters outside the font (emoji)', () => {
    expect(escapePdfText('hi 😀')).toBe('hi ?')
  })
})

describe('renderBrandedReportPdf', () => {
  it('produces a valid multi-page PDF with branded blocks and no "?"', () => {
    const blocks = Array.from({ length: 80 }, (_, i) => ({
      text: i % 10 === 0 ? `Section ${i}` : `Row ${i}: answered 92% · talk time 1h — it’s fine`,
      bold: i % 10 === 0,
      size: i % 10 === 0 ? 13 : 11,
      spacingBefore: i % 10 === 0 ? 16 : 2,
    }))
    const pdf = renderBrandedReportPdf({
      brandName: 'StudyMind CRM',
      title: 'Aircall call report',
      subtitle: '1 Jun – 30 Jun · All calls',
      generatedLine: 'Generated 1 Jul 2026',
      blocks,
    })
    const s = pdf.toString('latin1')
    expect(s.startsWith('%PDF-1.4')).toBe(true)
    expect(s.includes('%%EOF')).toBe(true)
    expect(s).toContain('Aircall call report')
    expect(Number(/\/Count (\d+)/.exec(s)?.[1])).toBeGreaterThan(1)
  })
})
