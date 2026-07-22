import { describe, expect, it } from 'vitest'

import { extractPreferredWhen, normaliseLead, normalisePhone } from './normalise'

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
  it('converts a 44-prefixed number typed without the +', () => {
    expect(normalisePhone('44 7700 900123').e164).toBe('+447700900123')
  })
  it('converts a UK mobile typed without the leading 0', () => {
    expect(normalisePhone('7700 900123').e164).toBe('+447700900123')
  })
  it('keeps the as-typed display when E.164 cannot be derived', () => {
    const r = normalisePhone('12345')
    expect(r.e164).toBeNull()
    expect(r.display).toBe('12345')
  })
  it('returns null for an unconvertible value', () => {
    expect(normalisePhone('hello').e164).toBeNull()
  })

  it('flags UK-national ASSUMPTIONS (bare 0…/7…) as assumedCountry GB', () => {
    // No country signal — the +44 is a guess the router may override from the IP.
    expect(normalisePhone('07700 900123').assumedCountry).toBe('GB')
    expect(normalisePhone('7700 900123').assumedCountry).toBe('GB')
  })

  it('treats explicitly-international numbers as assumedCountry null (never overridden)', () => {
    expect(normalisePhone('+447123456789').assumedCountry).toBeNull()
    expect(normalisePhone('0044 7700 900123').assumedCountry).toBeNull()
    expect(normalisePhone('44 7700 900123').assumedCountry).toBeNull()
    expect(normalisePhone('+33612345678').assumedCountry).toBeNull()
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

describe('extractPreferredWhen', () => {
  it('combines a separate date and time field (CF7 split)', () => {
    expect(extractPreferredWhen(['2026-06-10', '15:30'])).toBe('2026-06-10T15:30')
  })
  it('reads a UK D/M/Y date with am/pm time', () => {
    expect(extractPreferredWhen(['10/06/2026', '3pm'])).toBe('2026-06-10T15:00')
  })
  it('returns a bare date when no time is present', () => {
    expect(extractPreferredWhen(['2026-06-10'])).toBe('2026-06-10')
  })
  it('returns null for a lone time with no date', () => {
    expect(extractPreferredWhen(['3pm'])).toBeNull()
  })
})

describe('normaliseLead — preferred date/time + subject', () => {
  it('detects a CF7 date + time field and a course dropdown', () => {
    const out = normaliseLead({
      fields: {
        'your-name': 'Sam Patel',
        email: 'sam@example.test',
        'date-219': '2026-06-12',
        'time-44': '14:00',
        'which-course': 'UCAT',
      },
      meta: { url: 'https://medicmind.co.uk/book-a-call/' },
    })
    expect(out.preferredWhen).toBe('2026-06-12T14:00')
    expect(out.requestedSubject).toBe('UCAT')
    // The date/time/subject fields are consumed, not dumped into extras.
    expect(out.extraFields).not.toHaveProperty('date-219')
    expect(out.extraFields).not.toHaveProperty('time-44')
  })

  it('reads a preferred-call-time phrase from the message body', () => {
    const out = normaliseLead({
      fields: {
        name: 'Jo Lee',
        email: 'jo@example.test',
        'your-message': 'Please call me on 12/06/2026 around 4pm about A-Level Maths',
      },
    })
    expect(out.preferredWhen).toBe('2026-06-12T16:00')
  })
})

describe('normaliseLead — country field + URL message guard', () => {
  it('detects a country dropdown', () => {
    const out = normaliseLead({
      fields: { name: 'Enso T', email: 'e@example.test', country: 'Peru', phone: '928 812 118' },
    })
    expect(out.country).toBe('Peru')
    expect(out.phoneE164).toBeNull() // 9 digits — not a UK shape; composed later via country
    expect(out.phone).toBe('928 812 118')
  })

  it('never treats a bare URL value as the enquiry message', () => {
    const out = normaliseLead({
      fields: {
        name: 'Enso T',
        email: 'e@example.test',
        'mystery-field': 'https://www.medicmind.co.uk',
      },
    })
    expect(out.message).toBeNull()
  })
})

describe('normaliseLead — never name a contact after the freebie', () => {
  it('drops a resource-shaped value even from an EXPLICIT name field', () => {
    for (const bad of ['PLAB Questions', 'BMAT Questions', 'LNAT Questions', 'GAMSAT Questions']) {
      const out = normaliseLead({
        fields: { 'your-name': bad, 'email-1': 'jess@example.com' },
        meta: {},
      })
      expect(out.name).toBeNull()
      expect(out.firstName).toBeNull()
      expect(out.email).toBe('jess@example.com')
    }
  })

  it('refuses a product-shaped value as the name and leaves name null', () => {
    const out = normaliseLead({
      fields: {
        'text-901': 'GAMSAT Book',
        'email-1': 'jess@example.com',
      },
      meta: { url: 'https://medicmind.co.uk/gamsat-books/' },
    })
    expect(out.name).toBeNull()
    expect(out.firstName).toBeNull()
    expect(out.email).toBe('jess@example.com')
  })

  it('refuses product-ish KEYS even when the value looks like a name', () => {
    const out = normaliseLead({
      fields: {
        'product-title': 'Sarah Lawson',
        'email-1': 'real@example.com',
      },
      meta: {},
    })
    expect(out.name).toBeNull()
  })

  it('still sniffs a real person name from an unknown field', () => {
    const out = normaliseLead({
      fields: {
        'text-618': 'Aisha Rahman',
        'email-1': 'aisha@example.com',
      },
      meta: {},
    })
    expect(out.name).toBe('Aisha Rahman')
  })
})

describe('normaliseLead — visitor IP field (clientIp)', () => {
  it('lifts the CF7 _remote_ip field', () => {
    const out = normaliseLead({
      fields: { _remote_ip: '203.0.113.9', 'email-1': 'a@b.com' },
      meta: {},
    })
    expect(out.clientIp).toBe('203.0.113.9')
  })

  it('sniffs an IPv4-shaped value on an unknown key', () => {
    const out = normaliseLead({
      fields: { 'hidden-77': '198.51.100.24', 'email-1': 'a@b.com' },
      meta: {},
    })
    expect(out.clientIp).toBe('198.51.100.24')
  })

  it('is null when no IP-shaped field exists', () => {
    const out = normaliseLead({
      fields: { 'email-1': 'a@b.com' },
      meta: {},
    })
    expect(out.clientIp).toBeNull()
  })
})
