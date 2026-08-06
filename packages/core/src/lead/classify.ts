// Deterministic lead classifier (ADR 0023).
//
// Classifies primarily by landing domain / slug / form title — NOT the message
// body (spec). Brand comes from domain rules; products + categories from the
// configurable URL rules and the master product catalogue. Multi-category by
// design: a lead can be UCAT *and* Medicine Application *and* Interview. Pure;
// an AI pass can enrich this afterwards (see packages/jobs lead processor).

import { scoreLead } from './score'
import type { ClassificationRuleset, LeadClassification, NormalisedLead } from './types'

const HIGH_VALUE_CATEGORIES = new Set([
  'Consultation',
  'Interview',
  'Medicine Applications',
  'Dentistry Applications',
  'Oxbridge Admissions',
  'Oxford Admissions',
  'Cambridge Admissions',
  'Law Admissions',
])

/** The category a "Free Resources" URL rule emits. A lead carrying this
 * category routes to the Free Resources board instead of the Sales Pipeline.
 * It is never used as the card Subject (it's a routing signal, not a topic). */
export const FREE_RESOURCES_CATEGORY = 'Free Resources'

/** Generic service buckets — fine as a fallback Subject, but a specific exam
 * (UCAT, GAMSAT, A-Level Biology…) is preferred when present. */
const GENERIC_CATEGORIES = new Set([
  'Tutoring',
  'Course',
  'Mentoring',
  'Consultation',
  'Personal Statement',
  'Work Experience',
  FREE_RESOURCES_CATEGORY,
])

/** Academic LEVELS (key stage / qualification), not topics. A level says how
 * advanced the work is, never what it is about — "A-Level" is not a subject.
 *
 * These are still emitted as categories and stay stamped on the lead (the
 * operator wants to see GCSE / A-Level / IB); they are just barred from taking
 * the Subject slot while a real subject is available. Without this a Study Mind
 * enquiry from /subject/a-level-chemistry-tutors/ was tagged Subject "A-Level"
 * even though the page — and the matched `chemistry-tuition` product — say
 * Chemistry. Compared via `levelKey`, so "A Level", "A-Level" and "alevel" are
 * one value. */
const LEVEL_CATEGORIES: ReadonlySet<string> = new Set([
  'gcse',
  'igcse',
  'alevel',
  'aslevel',
  'a2',
  'ib',
  'ks1',
  'ks2',
  'ks3',
  'ks4',
  'ks5',
  '11plus',
  '13plus',
  'commonentrance',
  'sixthform',
  'primary',
  'secondary',
  'undergraduate',
  'postgraduate',
])

/** Fold a category/form value to its level key: lower-case, drop separators,
 *  and normalise the "+" in 11+/13+ so every spelling compares equal. */
function levelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\+/gu, 'plus')
    .replace(/[^a-z0-9]/gu, '')
}

function isLevel(value: string): boolean {
  return LEVEL_CATEGORIES.has(levelKey(value))
}

/**
 * Pick the single best Subject for the card tag.
 *
 * Order: a real SUBJECT the enquirer stated → a real subject the page implies →
 * the academic level → a generic service bucket. A level only becomes the
 * Subject when the page yields no subject at all, which is the previous
 * behaviour and the right fallback for a generic /contact or /consultation page.
 */
function pickSubject(formSubject: string | null, cats: string[]): string | null {
  const subjectCat = cats.find((c) => !GENERIC_CATEGORIES.has(c) && !isLevel(c))
  // The form value still wins when it IS a subject — the enquirer told us
  // directly. But a level dropdown ("A-Level", "GCSE") must never displace the
  // subject the landing page identifies.
  if (formSubject && !isLevel(formSubject)) return formSubject
  if (subjectCat) return subjectCat
  // Nothing subject-shaped anywhere: fall back to the level, then generic.
  if (formSubject) return formSubject
  const level = cats.find((c) => isLevel(c))
  if (level) return level
  const firstReal = cats.find((c) => c !== FREE_RESOURCES_CATEGORY)
  return firstReal ?? null
}

export interface ClassifyOptions {
  /** When the LeadSource pins a brand, it overrides domain detection. */
  forcedBrandId?: string | null
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))]
}

/** Pad with single spaces around word-boundaried tokens for safe phrase hits. */
function padded(s: string): string {
  return ` ${s
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()} `
}

function phraseHit(haystackPadded: string, needle: string): boolean {
  const n = needle
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!n) return false
  return haystackPadded.includes(` ${n} `)
}

function domainMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase()
  const p = pattern.toLowerCase()
  return h === p || h.endsWith(`.${p}`)
}

export function classifyLead(
  lead: NormalisedLead,
  ruleset: ClassificationRuleset,
  opts: ClassifyOptions = {},
): LeadClassification {
  const reasons: string[] = []
  const matchedRuleIds: string[] = []
  const categories: string[] = []
  const productTags: string[] = []

  let brandCompanyId: string | null = opts.forcedBrandId ?? null
  let brandReason: string | null = brandCompanyId ? 'pinned by lead source' : null

  // 1. Brand from domain rules (lowest priority number wins).
  if (!brandCompanyId && lead.landingDomain) {
    const rules = [...ruleset.brandRules].sort((a, b) => a.priority - b.priority)
    for (const r of rules) {
      if (domainMatches(lead.landingDomain, r.pattern)) {
        brandCompanyId = r.companyId
        brandReason = `domain ${lead.landingDomain} matched "${r.pattern}"`
        matchedRuleIds.push(r.id)
        break
      }
    }
  }

  // 2. URL / slug / form-title rules. Message is intentionally excluded here.
  const urlHay = padded(
    [lead.landingSlug, lead.landingUrl, lead.formTitle, lead.source].filter(Boolean).join(' '),
  )
  const urlRules = [...ruleset.urlRules].sort((a, b) => a.priority - b.priority)
  for (const r of urlRules) {
    let hit = false
    if (r.matchType === 'regex') {
      try {
        hit = new RegExp(r.pattern, 'iu').test(urlHay)
      } catch {
        hit = false
      }
    } else if (r.matchType === 'equals') {
      hit = (lead.landingSlug ?? '').toLowerCase() === r.pattern.toLowerCase()
    } else {
      hit = phraseHit(urlHay, r.pattern)
    }
    if (!hit) continue
    matchedRuleIds.push(r.id)
    productTags.push(...r.productTags)
    categories.push(...r.categories)
    if (!brandCompanyId && r.brandId) {
      brandCompanyId = r.brandId
      brandReason = `URL rule "${r.label}"`
    }
  }

  // 3. Product catalogue enrichment. Message allowed as a weak secondary so a
  //    free-text "I need UCAT help" still tags a product.
  const productHay = padded([urlHay, lead.message ?? ''].join(' '))
  for (const p of ruleset.products) {
    const needles = [p.handle, ...p.aliases]
    if (needles.some((n) => phraseHit(productHay, n))) {
      productTags.push(p.handle)
      categories.push(p.category)
      if (!brandCompanyId && p.brandId) {
        brandCompanyId = p.brandId
        brandReason = `product "${p.name}"`
      }
    }
  }

  const cats = uniq(categories)
  const prods = uniq(productTags)
  if (brandReason) reasons.push(`Brand: ${brandReason}`)
  if (cats.length) reasons.push(`Categories: ${cats.join(', ')}`)
  if (prods.length) reasons.push(`Products: ${prods.join(', ')}`)
  if (!brandCompanyId && !cats.length) reasons.push('No brand or category rule matched')

  const highValueIntent = cats.some((c) => HIGH_VALUE_CATEGORIES.has(c))
  const { score, reasons: scoreReasons } = scoreLead({
    hasEmail: Boolean(lead.email),
    hasPhone: Boolean(lead.phoneE164 ?? lead.phone),
    hasMessage: Boolean(lead.message),
    brandMatched: Boolean(brandCompanyId),
    productCount: prods.length,
    categoryCount: cats.length,
    parentInvolved: Boolean(lead.parentName),
    highValueIntent,
  })

  let confidence = 0.3
  if (brandCompanyId) confidence += 0.3
  if (matchedRuleIds.length > 0) confidence += 0.3
  if (lead.email || lead.phoneE164) confidence += 0.1
  confidence = Math.min(1, Number(confidence.toFixed(2)))

  // Routing: a "Free Resources" category (from a configurable URL rule, or a
  // form/slug/field that reads as a freebie / book / download) sends the lead
  // to the Free Resources board instead of the Sales Pipeline.
  //
  // Scan the WHOLE lead, not just the slug/title — a CF7 free-resource form
  // often carries "GAMSAT Book" in a product field that ends up as an
  // unmapped extraField (or was mis-read as the name), so a slug/title-only
  // scan let books leak onto Sales. Two tiers keep it honest:
  //  • strong freebie words (free resource, download, ebook, sample paper, …)
  //    match ANYWHERE — they can't be confused with a real enquiry;
  //  • a bare "book(s)" matches everywhere EXCEPT the message body, so
  //    "please book me a call" stays a sales lead while a "GAMSAT Book"
  //    product/title/field routes to Free Resources.
  const nameText = [lead.name, lead.firstName, lead.lastName].filter(Boolean).join(' ')
  const extraText = Object.values(lead.extraFields ?? {}).join(' ')
  const everything =
    `${lead.landingSlug ?? ''} ${lead.landingUrl ?? ''} ${lead.formTitle ?? ''} ${prods.join(' ')} ${lead.requestedSubject ?? ''} ${lead.source} ${lead.message ?? ''} ${nameText} ${extraText}`.toLowerCase()
  // Everything a product name could ride on EXCEPT the free-text message and
  // URL — the bare-"book" tier reads this so "book a call" never trips it.
  const productSignals =
    `${lead.landingSlug ?? ''} ${lead.formTitle ?? ''} ${prods.join(' ')} ${lead.requestedSubject ?? ''} ${nameText} ${extraText}`.toLowerCase()
  // A bare "book" is a free-resource product token ("GAMSAT Book"), but the
  // verb phrase "book a call / consultation / slot …" is a high-intent SALES
  // action that must NOT route to Free Resources — even when it appears in a
  // landing slug ("book-a-call") or form title, which productSignals includes.
  const bookVerbPhrase =
    /\bbook[- ]?(a|an|my|your|the|our|now|call|consultation|consult|slot|appointment|session|meeting|demo|place|seat|trial)\b/u
  const looksFree =
    cats.includes(FREE_RESOURCES_CATEGORY) ||
    /\b(free[- ]?resources?|free[- ]?downloads?|downloads?|freebies?|cheat[- ]?sheets?|free[- ]?guides?|free[- ]?e-?books?|free[- ]?books?|e-?books?|guide[- ]?books?|workbooks?|lead[- ]?magnets?|free[- ]?webinars?|free[- ]?tasters?|sample[- ]?papers?|past[- ]?papers?|revision[- ]?notes?)\b/u.test(
      everything,
    ) ||
    (/\bbooks?\b/u.test(productSignals) && !bookVerbPhrase.test(productSignals))
  const destination: LeadClassification['destination'] = looksFree ? 'free_resources' : 'sales'
  if (looksFree) reasons.push('Routed to Free Resources board')

  const subject = pickSubject(lead.requestedSubject, cats)
  if (subject) reasons.push(`Subject: ${subject}`)

  return {
    brandCompanyId,
    brandReason,
    categories: cats,
    productTags: prods,
    subject,
    destination,
    score,
    reasons: [...reasons, ...scoreReasons],
    matchedRuleIds: uniq(matchedRuleIds),
    method: 'rules',
    confidence,
  }
}
