// Lead ingestion + classification domain types (ADR 0023).
// Single source of truth for the normaliser, classifier, scorer, and the
// tRPC view-models. Pure — no Prisma row types leak in here so the engine
// stays testable and decoupled from the DB (CLAUDE.md §6, §30).

import { z } from 'zod'

/**
 * Lead lifecycle. Stored verbatim in `Lead.status`.
 * - received: persisted by /api/leads, not yet classified.
 * - classified: classification done but no contact action taken (e.g. no
 *   email AND no phone to match/onboard on — sits in the tray).
 * - onboarded: first enquiry → a new Contact + pipeline card were created.
 * - reenquiry: matched an existing Contact (annotated; maybe a fresh card).
 * - needs_triage: ambiguous match or unusable payload — an agent decides.
 * - dismissed: an agent dismissed it from the tray.
 */
export const LeadStatus = z.enum([
  'received',
  'classified',
  'onboarded',
  'reenquiry',
  'needs_triage',
  'dismissed',
])
export type LeadStatus = z.infer<typeof LeadStatus>

export const Utm = z
  .object({
    source: z.string(),
    medium: z.string(),
    campaign: z.string(),
    term: z.string(),
    content: z.string(),
  })
  .partial()
export type Utm = z.infer<typeof Utm>

/**
 * The clean, field-name-independent shape the normaliser produces from any
 * Contact-Form-7 / JSON / form-encoded payload. Downstream code never looks
 * at raw form keys like `text-618` — it reads this.
 */
export const NormalisedLead = z.object({
  /** Provenance label, e.g. "cf7:medicmind.co.uk/ucat-course". */
  source: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  /** Cleaned, display-friendly phone (not guaranteed E.164). */
  phone: z.string().nullable(),
  /** Strict E.164 when we could confidently normalise, else null. */
  phoneE164: z.string().nullable(),
  message: z.string().nullable(),
  parentName: z.string().nullable(),

  // Landing-page intelligence (CLAUDE.md §16) — drives classification first.
  landingDomain: z.string().nullable(),
  landingUrl: z.string().nullable(),
  landingSlug: z.string().nullable(),
  formTitle: z.string().nullable(),
  formId: z.string().nullable(),
  referrer: z.string().nullable(),
  utm: Utm.nullable(),

  /** Recognised-but-unmapped fields, kept for the payload inspector. */
  extraFields: z.record(z.string()),
})
export type NormalisedLead = z.infer<typeof NormalisedLead>

/** Deterministic classifier output. Stored on `Lead.classification`. */
export const LeadClassification = z.object({
  brandCompanyId: z.string().nullable(),
  brandReason: z.string().nullable(),
  categories: z.array(z.string()),
  productTags: z.array(z.string()),
  score: z.number().int().min(0).max(100),
  /** Human-readable reasons for the classification + score (audit/debug). */
  reasons: z.array(z.string()),
  /** Rule ids that fired — traceability + the learning loop. */
  matchedRuleIds: z.array(z.string()),
  method: z.enum(['rules', 'rules+ai']),
  confidence: z.number().min(0).max(1),
})
export type LeadClassification = z.infer<typeof LeadClassification>

// --- Rule inputs (lightweight mirrors of the Prisma rows) -------------------
// The job maps DB rows → these so core never imports the DB row shape.

export interface BrandDomainRuleInput {
  id: string
  pattern: string
  companyId: string
  priority: number
}

export interface UrlClassificationRuleInput {
  id: string
  label: string
  pattern: string
  matchType: string
  productTags: string[]
  categories: string[]
  brandId: string | null
  priority: number
}

export interface ProductCatalogueItemInput {
  id: string
  handle: string
  name: string
  category: string
  aliases: string[]
  brandId: string | null
}

export interface ClassificationRuleset {
  brandRules: BrandDomainRuleInput[]
  urlRules: UrlClassificationRuleInput[]
  products: ProductCatalogueItemInput[]
}
