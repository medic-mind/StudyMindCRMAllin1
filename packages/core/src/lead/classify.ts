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

  return {
    brandCompanyId,
    brandReason,
    categories: cats,
    productTags: prods,
    score,
    reasons: [...reasons, ...scoreReasons],
    matchedRuleIds: uniq(matchedRuleIds),
    method: 'rules',
    confidence,
  }
}
