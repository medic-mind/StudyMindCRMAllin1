// Section manifest for the imported company knowledge base (ADR 0040).
//
// Every top-level key in `crib-data.json` maps to exactly one section here —
// `knowledge.test.ts` fails if the data and this manifest drift, so a future
// re-import that adds a key cannot silently vanish from the UI.

import rawData from './crib-data.json'
import { COMMON_SCENARIOS } from './scenarios'
import type { KnowledgeGroup, KnowledgeSectionDef, KnowledgeValue } from './types'

// crib-data.json is a byte-for-byte copy of the Crib's defaults.json; the
// common-scenarios content lived in the Crib FRONTEND, so it merges in here
// (see scenarios.ts). Re-import stays a plain file copy.
const KNOWLEDGE_DATA = {
  ...(rawData as unknown as Record<string, KnowledgeValue>),
  commonScenarios: COMMON_SCENARIOS,
} as Readonly<Record<string, KnowledgeValue>>

export const KNOWLEDGE_GROUP_ORDER: readonly KnowledgeGroup[] = [
  'Brands & products',
  'Packages & pricing',
  'Sales playbook',
  'Events & operations',
  'Reference',
]

export const KNOWLEDGE_SECTIONS: readonly KnowledgeSectionDef[] = [
  // ── Brands & products ────────────────────────────────────────────────
  {
    slug: 'brands',
    dataKey: 'brands',
    title: 'Brands',
    blurb:
      'The StudyMind umbrella and its sub-brands — MedicMind, OxbridgeMind, LawMind, DentalMind — domains, taglines and what each one owns.',
    group: 'Brands & products',
  },
  {
    slug: 'hubs',
    dataKey: 'hubs',
    title: 'Hubs',
    blurb:
      'Per-hub cheat sheets: medicine, dentistry, vet, Oxbridge, law, A-levels, GCSE and career camps in one view each.',
    group: 'Brands & products',
  },
  {
    slug: 'products',
    dataKey: 'products',
    title: 'Products',
    blurb:
      'Every sellable product across the brands — what it includes, pricing shape, target hours and links.',
    group: 'Brands & products',
  },
  {
    slug: 'people',
    dataKey: 'people',
    title: 'Key people',
    blurb:
      'Who owns what — the names to route camps, discounts, AP and VIP enquiries to.',
    group: 'Brands & products',
  },
  // ── Packages & pricing ───────────────────────────────────────────────
  {
    slug: 'full-application',
    dataKey: 'fullApplication',
    title: 'Full Application Scheme',
    blurb:
      'Bronze / Silver / Gold / Platinum tiers, hour splits, the Premium Tutor add-on, hour flexibility and the money-back guarantee.',
    group: 'Packages & pricing',
  },
  {
    slug: 'standalone-targets',
    dataKey: 'standaloneProductTargets',
    title: 'Standalone product targets',
    blurb: 'The standard hours to aim for on non-bundled sales, product by product.',
    group: 'Packages & pricing',
  },
  {
    slug: 'pricing',
    dataKey: 'pricing',
    title: 'Pricing & economics',
    blurb:
      'Tutor pay, sale rates, margins, add-on costs, discount levers and guarantees — the unit economics behind every quote.',
    group: 'Packages & pricing',
  },
  {
    slug: 'subject-pricing',
    dataKey: 'subjectPricing',
    title: 'Subject pricing',
    blurb:
      'Per-subject rate cards, live-day costs, the Premium Tutor upgrade and safe-margin guidance.',
    group: 'Packages & pricing',
  },
  {
    slug: 'master-pricing',
    dataKey: 'masterPricing',
    title: 'Master pricing',
    blurb: 'The fixed per-hour rate tiers and pricing ladders.',
    group: 'Packages & pricing',
  },
  {
    slug: 'oxbridge-pricing',
    dataKey: 'oxbridgePricing',
    title: 'Oxbridge pricing & packages',
    blurb:
      'The OxbridgeMind rate ladder and package set, Intro through Platinum Plus.',
    group: 'Packages & pricing',
  },
  // ── Sales playbook ───────────────────────────────────────────────────
  {
    slug: 'upsell',
    dataKey: 'upsell',
    title: 'Upsell playbook',
    blurb:
      'The complimentary-hours ladder, free and near-free upsell items, the step ladder and the hard do-nots.',
    group: 'Sales playbook',
  },
  {
    slug: 'scripts',
    dataKey: 'scripts',
    title: 'Sales scripts',
    blurb:
      'Call scripts — general openers, discovery, objections and closes, plus per-hub and per-product variants.',
    group: 'Sales playbook',
  },
  {
    slug: 'sales-tips',
    dataKey: 'salesTips',
    title: 'Sales tips',
    blurb: 'Field-tested tips from the team for handling calls and enquiries.',
    group: 'Sales playbook',
  },
  {
    slug: 'routing',
    dataKey: 'routing',
    title: 'Internal routing',
    blurb:
      'Who handles which enquiry — the decision tree, preferred channels and escalation rules.',
    group: 'Sales playbook',
  },
  {
    slug: 'common-scenarios',
    dataKey: 'commonScenarios',
    title: 'Common scenarios',
    blurb:
      'Recurring call patterns and the quickest way to handle each — tone plus step-by-step guidance.',
    group: 'Sales playbook',
  },
  // ── Events & operations ──────────────────────────────────────────────
  {
    slug: 'live-days',
    dataKey: 'liveDays',
    title: 'Live Days',
    blurb:
      'Easter, UCAT and Oxbridge live days — 2026 schedules, protocols and cancellation rules.',
    group: 'Events & operations',
  },
  {
    slug: 'mmi-circuits',
    dataKey: 'mmiCircuits',
    title: 'MMI Circuits',
    blurb:
      '2026/27 circuit dates online and in person, formats, cancellation policy and customer pricing.',
    group: 'Events & operations',
  },
  {
    slug: 'career-camps',
    dataKey: 'careerCamps',
    title: 'Summer Career Camps',
    blurb:
      'Camps 2026 — dates, subjects, pricing, accommodation, safety, check-in, FAQ, bursary, visas and DoE.',
    group: 'Events & operations',
  },
  {
    slug: 'shadowing',
    dataKey: 'shadowing',
    title: 'Shadowing placements',
    blurb:
      'GP, dental, vet and chemistry-lab placements — the pricing ladder and the internal partner practices.',
    group: 'Events & operations',
  },
  {
    slug: 'mmi-circuit-ops',
    dataKey: 'mmiCircuitOps',
    title: 'MMI Circuit operations',
    blurb:
      'Running an in-person circuit — roles, booking flow, tutor and manager briefs, venues and the checklist.',
    group: 'Events & operations',
  },
  {
    slug: 'tutor-hiring',
    dataKey: 'tutorHiring',
    title: 'Tutor hiring',
    blurb: 'Requirements, process, links and red flags for hiring tutors.',
    group: 'Events & operations',
  },
  // ── Reference ────────────────────────────────────────────────────────
  {
    slug: 'oxbridge-exams',
    dataKey: 'oxbridgeExams',
    title: 'Oxbridge exams 2026',
    blurb:
      'The live UAT-UK tests (TMUA, ESAT, TARA…), the dropped tests, and what changed for 2026 entry.',
    group: 'Reference',
  },
  {
    slug: 'taxonomy',
    dataKey: 'subjectTaxonomy',
    title: 'Subject taxonomy',
    blurb:
      'Every bookable subject by category, with legacy admissions tests flagged archive-only.',
    group: 'Reference',
  },
  {
    slug: 'education-system',
    dataKey: 'educationSystem',
    title: 'UK education system',
    blurb:
      'Stages, year-group equivalence and the exam map — for speaking fluently to parents.',
    group: 'Reference',
  },
  {
    slug: 'timelines',
    dataKey: 'timelines',
    title: 'Application timelines',
    blurb: 'The UCAT, Oxbridge, Medicine and LNAT cycles, step by step.',
    group: 'Reference',
  },
  {
    slug: 'glossary',
    dataKey: 'glossary',
    title: 'Glossary',
    blurb: 'Terms VAs and sales staff need — defined in one place.',
    group: 'Reference',
  },
  {
    slug: 'faq',
    dataKey: 'faq',
    title: 'FAQ',
    blurb: 'Frequently asked questions from parents and students, with answers.',
    group: 'Reference',
  },
]

const BY_SLUG = new Map(KNOWLEDGE_SECTIONS.map((s) => [s.slug, s]))

export function listKnowledgeSections(): readonly KnowledgeSectionDef[] {
  return KNOWLEDGE_SECTIONS
}

export function getKnowledgeSection(slug: string): KnowledgeSectionDef | undefined {
  return BY_SLUG.get(slug)
}

/** The whole imported knowledge data, keyed by top-level data key. */
export function getKnowledgeData(): Readonly<Record<string, KnowledgeValue>> {
  return KNOWLEDGE_DATA
}

/** The raw data behind one section, or undefined for an unknown slug. */
export function getKnowledgeSectionData(slug: string): KnowledgeValue | undefined {
  const section = BY_SLUG.get(slug)
  if (!section) return undefined
  return KNOWLEDGE_DATA[section.dataKey]
}
