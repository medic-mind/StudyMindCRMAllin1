// Auto-classifier tests. Deterministic rules: domain > name; confident school
// words file automatically; no signal → Unsorted tray.

import { describe, expect, it } from 'vitest'

import { classifyAccount, CONFIDENT_THRESHOLD } from './classify-account'

describe('classifyAccount', () => {
  it('files an obvious school by name, confidently', () => {
    const r = classifyAccount({ companyName: 'Oakwood Primary School' })
    expect(r.kind).toBe('school')
    expect(r.needsClassification).toBe(false)
    expect(r.confidence).toBeGreaterThanOrEqual(CONFIDENT_THRESHOLD)
  })

  it('treats a .sch.uk domain as a school even if the name reads commercial', () => {
    const r = classifyAccount({
      companyName: 'Bright Futures Ltd',
      contactEmail: 'office@brightfutures.sch.uk',
    })
    expect(r.kind).toBe('school')
    expect(r.needsClassification).toBe(false)
    expect(r.reason).toMatch(/sch\.uk/)
  })

  it('files an academy / college as a school', () => {
    expect(classifyAccount({ companyName: 'St Mary Academy' }).kind).toBe('school')
    expect(classifyAccount({ companyName: 'Riverside College' }).kind).toBe('school')
  })

  it('files a clear company as a B2B partner', () => {
    const r = classifyAccount({ companyName: 'Apex Tutoring Ltd' })
    expect(r.kind).toBe('partnership')
    expect(r.needsClassification).toBe(false)
  })

  it('sends a no-signal name to the tray (weak default partner)', () => {
    const r = classifyAccount({ companyName: 'Greenfield' })
    expect(r.needsClassification).toBe(true)
    expect(r.confidence).toBe(0)
    expect(r.kind).toBe('partnership')
  })

  it('domain outranks a competing company word', () => {
    const r = classifyAccount({
      companyName: 'Education Services Group',
      website: 'https://example.ac.uk',
    })
    expect(r.kind).toBe('school')
    expect(r.needsClassification).toBe(false)
  })

  it('a .gov.uk (council/LA) is treated as school-side for invoicing', () => {
    const r = classifyAccount({
      companyName: 'County Council',
      contactEmail: 'send@countycouncil.gov.uk',
    })
    expect(r.kind).toBe('school')
    expect(r.reason).toMatch(/gov\.uk/)
  })
})
