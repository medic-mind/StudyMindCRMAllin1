import { describe, expect, it } from 'vitest'

import { classifyLead } from './classify'
import { normaliseLead } from './normalise'
import type { ClassificationRuleset, NormalisedLead } from './types'

const ruleset: ClassificationRuleset = {
  brandRules: [
    { id: 'b1', pattern: 'medicmind.co.uk', companyId: 'cmp_medic', priority: 100 },
    { id: 'b2', pattern: 'studymind.co.uk', companyId: 'cmp_study', priority: 100 },
  ],
  urlRules: [
    {
      id: 'u1',
      label: 'UCAT',
      pattern: 'ucat',
      matchType: 'contains',
      productTags: ['ucat'],
      categories: ['UCAT'],
      brandId: 'cmp_medic',
      priority: 50,
    },
    {
      id: 'u2',
      label: 'Interview',
      pattern: 'interview',
      matchType: 'contains',
      productTags: ['mmi-interview'],
      categories: ['Interview'],
      brandId: null,
      priority: 100,
    },
    {
      id: 'u3',
      label: 'A-Level',
      pattern: 'a-level',
      matchType: 'contains',
      productTags: [],
      categories: ['A-Level'],
      brandId: 'cmp_study',
      priority: 100,
    },
    {
      id: 'u4',
      label: 'Free Resources',
      pattern: 'free-resources',
      matchType: 'contains',
      productTags: [],
      categories: ['Free Resources'],
      brandId: null,
      priority: 100,
    },
  ],
  products: [
    {
      id: 'p1',
      handle: 'ucat-course',
      name: 'UCAT Course',
      category: 'UCAT',
      aliases: ['ucat'],
      brandId: 'cmp_medic',
    },
    { id: 'p2', handle: 'mat', name: 'MAT', category: 'MAT', aliases: [], brandId: 'cmp_oxbridge' },
  ],
}

function lead(partial: Partial<NormalisedLead>): NormalisedLead {
  return {
    source: 'test',
    name: null,
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    phoneE164: null,
    message: null,
    parentName: null,
    preferredWhen: null,
    requestedSubject: null,
    country: null,
    landingDomain: null,
    landingUrl: null,
    landingSlug: null,
    formTitle: null,
    formId: null,
    referrer: null,
    utm: null,
    extraFields: {},
    ...partial,
  }
}

describe('classifyLead — brand detection', () => {
  it('resolves the brand from the landing domain', () => {
    const c = classifyLead(
      lead({ landingDomain: 'medicmind.co.uk', landingSlug: 'ucat-course' }),
      ruleset,
    )
    expect(c.brandCompanyId).toBe('cmp_medic')
    expect(c.categories).toContain('UCAT')
    expect(c.productTags).toEqual(expect.arrayContaining(['ucat', 'ucat-course']))
    expect(c.matchedRuleIds).toContain('u1')
  })

  it('honours a forced brand from the lead source', () => {
    const c = classifyLead(lead({ landingDomain: 'medicmind.co.uk' }), ruleset, {
      forcedBrandId: 'cmp_study',
    })
    expect(c.brandCompanyId).toBe('cmp_study')
  })

  it('infers the brand from a URL rule when no domain rule matches', () => {
    const c = classifyLead(lead({ landingSlug: 'ucat-crash-course' }), ruleset)
    expect(c.brandCompanyId).toBe('cmp_medic')
  })
})

describe('classifyLead — multi-category by design', () => {
  it('keeps every matching category and product, never forcing one bucket', () => {
    const c = classifyLead(
      lead({
        landingDomain: 'medicmind.co.uk',
        landingSlug: 'ucat-and-interview-prep',
        formTitle: 'Medicine Interview',
      }),
      ruleset,
    )
    expect(c.categories).toEqual(expect.arrayContaining(['UCAT', 'Interview']))
    expect(c.productTags).toEqual(expect.arrayContaining(['ucat', 'mmi-interview']))
  })
})

describe('classifyLead — no false positives on short tokens', () => {
  it('does not tag the MAT exam when the message merely says "mathematics"', () => {
    const c = classifyLead(
      lead({
        landingDomain: 'studymind.co.uk',
        landingSlug: 'a-level-tuition',
        message: 'I need mathematics tuition',
      }),
      ruleset,
    )
    expect(c.productTags).not.toContain('mat')
    expect(c.categories).toContain('A-Level')
    expect(c.brandCompanyId).toBe('cmp_study')
  })
})

describe('classifyLead — scoring + confidence', () => {
  it('scores a phone-supplied, branded, multi-service lead highly', () => {
    const normalised = normaliseLead({
      fields: {
        name: 'Pat Lee',
        email: 'pat@x.com',
        phone: '+447123456789',
        message: 'UCAT and interview help please',
      },
      meta: { url: 'https://medicmind.co.uk/ucat-interview/' },
    })
    const c = classifyLead(normalised, ruleset)
    expect(c.score).toBeGreaterThanOrEqual(70)
    expect(c.confidence).toBeGreaterThan(0.5)
    expect(c.method).toBe('rules')
  })

  it('keeps an unrecognised lead low and unbranded', () => {
    const c = classifyLead(lead({ email: 'x@y.com', landingDomain: 'example.com' }), ruleset)
    expect(c.brandCompanyId).toBeNull()
    expect(c.categories).toHaveLength(0)
    expect(c.score).toBeLessThan(60)
  })
})

describe('classifyLead — subject + board routing', () => {
  it('routes a free-resources enquiry to the Free Resources board', () => {
    const c = classifyLead(
      lead({ landingDomain: 'medicmind.co.uk', landingSlug: 'free-resources/ucat-guide' }),
      ruleset,
    )
    expect(c.destination).toBe('free_resources')
    // The category routes; the subject is still the real topic (UCAT), not the
    // "Free Resources" marker.
    expect(c.subject).toBe('UCAT')
  })

  it('routes a freebie/download slug even without a matching rule', () => {
    const c = classifyLead(
      lead({ landingDomain: 'studymind.co.uk', landingSlug: 'free-download/maths-cheat-sheet' }),
      ruleset,
    )
    expect(c.destination).toBe('free_resources')
  })

  it('keeps a normal sales enquiry on the sales board', () => {
    const c = classifyLead(
      lead({ landingDomain: 'medicmind.co.uk', landingSlug: 'ucat-course' }),
      ruleset,
    )
    expect(c.destination).toBe('sales')
    expect(c.subject).toBe('UCAT')
  })

  it('prefers the form-selected subject over the URL category', () => {
    const c = classifyLead(
      lead({
        landingDomain: 'medicmind.co.uk',
        landingSlug: 'ucat-course',
        requestedSubject: 'Medicine Interview',
      }),
      ruleset,
    )
    expect(c.subject).toBe('Medicine Interview')
  })
})
