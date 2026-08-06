// Regression: the Subject tag must be the TOPIC of the page, not the academic
// level (2026-08 live bug).
//
// A Study Mind enquiry from /subject/a-level-chemistry-tutors/ matched the
// `chemistry-tuition` product and still came out tagged Subject "A-Level". Two
// compounding causes, both covered here:
//
//   1. the seeded subject products carried the LEVEL as their category
//      (chemistry-tuition -> 'A-Level'), so "Chemistry" never reached the
//      lead's categories at all — fixed by migration
//      20260806090000_fix_subject_product_categories;
//   2. pickSubject treated a level like any other specific category, and let a
//      form-selected level override the page entirely.
//
// Operator requirement (2026-08): keep the level stamped on the lead, but the
// SUBJECT must come from the page when the page identifies one, falling back to
// the level only when it does not.

import { describe, expect, it } from 'vitest'

import { classifyLead } from './classify'
import { normaliseLead } from './normalise'
import type { ClassificationRuleset } from './types'

const SM = 'cmp_seed_study_mind'

/** The seeded rules + products as they exist AFTER the category migration. */
const RULES: ClassificationRuleset = {
  brandRules: [{ id: 'b_sm', pattern: 'studymind.co.uk', companyId: SM, priority: 10 }],
  urlRules: [
    {
      id: 'urc_seed_gcse',
      label: 'GCSE',
      pattern: 'gcse',
      matchType: 'contains',
      productTags: [],
      categories: ['GCSE'],
      brandId: SM,
      priority: 100,
    },
    {
      id: 'urc_seed_alevel',
      label: 'A-Level',
      pattern: 'a-level',
      matchType: 'contains',
      productTags: [],
      categories: ['A-Level'],
      brandId: SM,
      priority: 100,
    },
    {
      id: 'urc_seed_ib',
      label: 'IB',
      pattern: 'ib-tuition',
      matchType: 'contains',
      productTags: [],
      categories: ['IB'],
      brandId: SM,
      priority: 100,
    },
    {
      id: 'urc_seed_tutoring',
      label: 'Tutoring',
      pattern: 'tutoring',
      matchType: 'contains',
      productTags: [],
      categories: ['Tutoring'],
      brandId: null,
      priority: 100,
    },
    {
      id: 'urc_seed_consult',
      label: 'Consultation',
      pattern: 'consultation',
      matchType: 'contains',
      productTags: [],
      categories: ['Consultation'],
      brandId: null,
      priority: 100,
    },
  ],
  products: [
    {
      id: 'prd_seed_alevel_tuition',
      handle: 'a-level-tuition',
      name: 'A-Level Tuition',
      category: 'A-Level',
      aliases: ['a level', 'alevel'],
      brandId: SM,
    },
    {
      id: 'prd_seed_gcse_tuition',
      handle: 'gcse-tuition',
      name: 'GCSE Tuition',
      category: 'GCSE',
      aliases: ['gcse'],
      brandId: SM,
    },
    {
      id: 'prd_seed_chemistry',
      handle: 'chemistry-tuition',
      name: 'Chemistry Tuition',
      category: 'Chemistry',
      aliases: ['chemistry'],
      brandId: SM,
    },
    {
      id: 'prd_seed_maths',
      handle: 'maths-tuition',
      name: 'Mathematics Tuition',
      category: 'Maths',
      aliases: ['maths', 'mathematics'],
      brandId: SM,
    },
    {
      id: 'prd_seed_biology',
      handle: 'biology-tuition',
      name: 'Biology Tuition',
      category: 'Biology',
      aliases: ['biology'],
      brandId: SM,
    },
  ],
}

function classify(url: string, fields: Record<string, unknown> = {}) {
  const lead = normaliseLead({
    fields: { 'your-name': 'Test Enquirer', 'your-email': 'test@example.com', ...fields },
    meta: { url },
  })
  return classifyLead(lead, RULES)
}

describe('Subject is the page topic, not the academic level', () => {
  it('tags Chemistry — the live reported lead', () => {
    const c = classify('https://studymind.co.uk/subject/a-level-chemistry-tutors/')
    expect(c.subject).toBe('Chemistry')
  })

  it('still stamps the level as a category alongside it', () => {
    const c = classify('https://studymind.co.uk/subject/a-level-chemistry-tutors/')
    expect(c.categories).toContain('A-Level')
    expect(c.categories).toContain('Chemistry')
  })

  it.each([
    ['https://studymind.co.uk/subject/a-level-maths-tutors/', 'Maths', 'A-Level'],
    ['https://studymind.co.uk/subject/gcse-biology-tutors/', 'Biology', 'GCSE'],
    ['https://studymind.co.uk/subject/gcse-chemistry-tutors/', 'Chemistry', 'GCSE'],
  ])('%s -> subject %s, level %s retained', (url, subject, level) => {
    const c = classify(url)
    expect(c.subject).toBe(subject)
    expect(c.categories).toContain(level)
  })

  it('falls back to the level when the page identifies no subject', () => {
    // A generic booking page: level is all we know, so it is the right Subject.
    const c = classify('https://studymind.co.uk/a-level-tutoring/')
    expect(c.subject).toBe('A-Level')
  })

  it('falls back to GCSE / IB the same way', () => {
    expect(classify('https://studymind.co.uk/gcse-tutoring/').subject).toBe('GCSE')
    expect(classify('https://studymind.co.uk/ib-tuition/').subject).toBe('IB')
  })

  it('a level dropdown on the form never displaces the page subject', () => {
    const url = 'https://studymind.co.uk/subject/a-level-chemistry-tutors/'
    for (const level of ['A-Level', 'A Level', 'alevel', 'GCSE', 'IB', '11+']) {
      expect(classify(url, { course: level }).subject).toBe('Chemistry')
      expect(classify(url, { subject: level }).subject).toBe('Chemistry')
    }
  })

  it('a level dropdown IS the subject when the page has none', () => {
    const c = classify('https://studymind.co.uk/book-a-consultation/', { course: 'A-Level' })
    expect(c.subject).toBe('A-Level')
  })

  it('a genuine subject typed on the form still wins', () => {
    const c = classify('https://studymind.co.uk/book-a-consultation/', { subject: 'Further Maths' })
    expect(c.subject).toBe('Further Maths')
  })

  it('prefers a real subject over a generic service bucket', () => {
    // Tutoring/Consultation are generic; Chemistry must win.
    const c = classify('https://studymind.co.uk/subject/a-level-chemistry-tutors/')
    expect(c.subject).not.toBe('Tutoring')
    expect(c.subject).not.toBe('Consultation')
  })
})
