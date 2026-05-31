import { describe, expect, it } from 'vitest'

import { normaliseLead, normalisePhone } from './normalise'

describe('normalisePhone', () => {
  it('keeps a valid E.164 number', () => {
    expect(normalisePhone('+447123456789').e164).toBe('+447123456789')
  })
  it('converts a UK 0-prefixed number with spaces', () => {
    expect(normalisePhone('07700 900123').e164).toBe('+447700900123')
  })
  it('converts a 00-prefixed international number', () => {
    expect(normalisePhone('0044 7700 900123').e164).toBe('+447700900123')
  })
  it('returns null for an unconvertible value', () => {
    expect(normalisePhone('hello').e164).toBeNull()
  })
})

describe('normaliseLead — webhook: mappings (the user’s forms)', () => {
  it('maps webhook:name / webhook:email / webhook:phone regardless of CF7 ids', () => {
    const out = normaliseLead({
      fields: {
        'webhook:name': 'John Smith',
        'webhook:email': 'JOHN@email.com',
        'webhook:phone': '+447123456789',
      },
      meta: { url: 'https://medicmind.co.uk/ucat-course/' },
    })
    expect(out.name).toBe('John Smith')
    expect(out.firstName).toBe('John')
    expect(out.lastName).toBe('Smith')
    expect(out.email).toBe('john@email.com')
    expect(out.phoneE164).toBe('+447123456789')
    expect(out.landingDomain).toBe('medicmind.co.uk')
    expect(out.landingSlug).toBe('ucat-course')
  })
})

describe('normaliseLead — raw CF7 field ids + value heuristics', () => {
  it('detects roles from CF7 type prefixes (text-/tel-/email-/textarea-)', () => {
    const out = normaliseLead({
      fields: {
        'text-618': 'Jane Doe',
        'tel-146': '07700 900123',
        'email-99': 'jane@x.com',
        'textarea-3': 'I would like help preparing for my UCAT over the summer please',
        _wpcf7: '1234',
        'g-recaptcha-response': 'abc',
      },
      meta: { url: 'https://medicmind.co.uk/ucat/?utm_source=google&utm_medium=cpc' },
    })
    expect(out.email).toBe('jane@x.com')
    expect(out.phoneE164).toBe('+447700900123')
    expect(out.message).toContain('UCAT')
    expect(out.name).toBe('Jane Doe')
    expect(out.utm).toEqual({ source: 'google', medium: 'cpc' })
    // CF7 internal noise never leaks into the inspector.
    expect(Object.keys(out.extraFields)).not.toContain('_wpcf7')
  })

  it('falls back to value sniffing when no key is recognisable', () => {
    const out = normaliseLead({
      fields: {
        'field-a': 'someone@example.org',
        'field-b': '07111111111',
        'field-c': 'This is clearly the long free-text body of an enquiry message',
      },
    })
    expect(out.email).toBe('someone@example.org')
    expect(out.phoneE164).toBe('+447111111111')
    expect(out.message).toContain('free-text body')
  })
})

describe('normaliseLead — first/last + landing fallbacks', () => {
  it('composes name from separate first/last fields and captures parent', () => {
    const out = normaliseLead({
      fields: {
        'first-name': 'Amir',
        'last-name': 'Khan',
        'parent-name': 'Sara Khan',
        email: 'amir@example.com',
      },
    })
    expect(out.name).toBe('Amir Khan')
    expect(out.parentName).toBe('Sara Khan')
  })

  it('derives the domain from the Referer header when no url field exists', () => {
    const out = normaliseLead({
      fields: { email: 'x@y.com' },
      headers: { referer: 'https://www.oxbridgemind.co.uk/oxbridge-admissions/apply' },
    })
    expect(out.landingDomain).toBe('oxbridgemind.co.uk')
    expect(out.landingSlug).toBe('oxbridge-admissions/apply')
  })
})
