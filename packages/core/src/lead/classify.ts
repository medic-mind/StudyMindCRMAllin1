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

/** Pick the single best Subject for the card tag: the form-selected subject
 * wins (the enquirer told us directly), then the most-specific category. */
function pickSubject(formSubject: string | null, cats: string[]): string | null {
  if (formSubject) return formSubject
  const specific = cats.find((c) => !GENERIC_CATEGORIES.has(c))
  if (specific) return specific
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
  const looksFree =
    cats.includes(FREE_RESOURCES_CATEGORY) ||
    /\b(free[- ]?resources?|free[- ]?downloads?|downloads?|freebies?|cheat[- ]?sheets?|free[- ]?guides?|free[- ]?e-?books?|free[- ]?books?|e-?books?|guide[- ]?books?|workbooks?|lead[- ]?magnets?|free[- ]?webinars?|free[- ]?tasters?|sample[- ]?papers?|past[- ]?papers?|revision[- ]?notes?)\b/u.test(
      everything,
    ) ||
    /\bbooks?\b/u.test(productSignals)
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
