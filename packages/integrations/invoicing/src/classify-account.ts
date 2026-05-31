// Auto-classify an imported B2B customer as a `school` or a `partnership`
// (UI label "B2B Partner"). The invoicing platform tags every business
// customer simply as `b2b` — it does not distinguish schools from partners —
// so we infer it from the name / email domain / website, and punt to the
// "Unsorted" tray when there is no confident signal.
//
// Pure + deterministic (no I/O, no API cost), mirroring the rules-first lead
// classifier (ADR 0023). An optional AI pass can refine low-confidence cases
// at the worker boundary, but the rules alone are enough to file the obvious
// ones and keep the tray small.

export type AccountKind = 'school' | 'partnership'

export interface ClassifyAccountInput {
  companyName: string
  contactEmail?: string | null
  website?: string | null
}

export interface ClassifyAccountResult {
  /** Best guess. When `needsClassification` is true this is a weak default and
   *  the row should still land in the tray for a human to confirm. */
  kind: AccountKind
  /** True when no rule fired with enough confidence — send to the tray. */
  needsClassification: boolean
  /** 0..1. >= CONFIDENT_THRESHOLD files it automatically. */
  confidence: number
  /** Short human-readable rationale for the tray UI. */
  reason: string
}

/** At or above this, we file the account without human review. */
export const CONFIDENT_THRESHOLD = 0.7

// Strong school signals in a name. Word-boundary matched, case-insensitive.
const SCHOOL_NAME_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bschool\b/i, label: "name contains 'school'" },
  { re: /\bacademy\b/i, label: "name contains 'academy'" },
  { re: /\bcollege\b/i, label: "name contains 'college'" },
  { re: /\bprimary\b/i, label: "name contains 'primary'" },
  { re: /\bsecondary\b/i, label: "name contains 'secondary'" },
  { re: /\bsixth form\b/i, label: "name contains 'sixth form'" },
  { re: /\bhigh school\b/i, label: "name contains 'high school'" },
  { re: /\bgrammar\b/i, label: "name contains 'grammar'" },
  { re: /\bprep(aratory)?\b/i, label: "name contains 'prep'" },
  { re: /\binfant\b/i, label: "name contains 'infant'" },
  { re: /\bjunior school\b/i, label: "name contains 'junior school'" },
  { re: /\bcomprehensive\b/i, label: "name contains 'comprehensive'" },
]

// School-ish email/website domains. `.sch.uk` and `.ac.uk` are near-certain;
// the education gov domains are strong too.
const SCHOOL_DOMAIN_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\.sch\.uk$/i, label: 'domain .sch.uk' },
  { re: /\.ac\.uk$/i, label: 'domain .ac.uk' },
  { re: /\.edu(\.[a-z]{2})?$/i, label: 'domain .edu' },
  { re: /\.gov\.uk$/i, label: 'domain .gov.uk (council/LA)' },
]

// Partner / agency / commercial signals in a name.
const PARTNER_NAME_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bltd\b/i, label: "name contains 'Ltd'" },
  { re: /\blimited\b/i, label: "name contains 'Limited'" },
  { re: /\bllp\b/i, label: "name contains 'LLP'" },
  { re: /\bplc\b/i, label: "name contains 'PLC'" },
  { re: /\btutors?\b/i, label: "name contains 'tutor'" },
  { re: /\btutoring\b/i, label: "name contains 'tutoring'" },
  { re: /\bagency\b/i, label: "name contains 'agency'" },
  { re: /\bpartners?\b/i, label: "name contains 'partner'" },
  { re: /\bconsult/i, label: "name contains 'consult'" },
  { re: /\bgroup\b/i, label: "name contains 'group'" },
  { re: /\bservices\b/i, label: "name contains 'services'" },
  { re: /\beducation\b/i, label: "name contains 'education' (provider)" },
]

function domainOf(email?: string | null, website?: string | null): string | null {
  const fromEmail = email?.includes('@') ? email.split('@').pop() : null
  if (fromEmail) return fromEmail.trim().toLowerCase()
  if (website) {
    try {
      const url = website.includes('://') ? website : `https://${website}`
      return new URL(url).hostname.toLowerCase()
    } catch {
      return null
    }
  }
  return null
}

/**
 * Classify a single account. Rules-first; deterministic. Domain signals
 * outrank name signals (a `.sch.uk` is a school even if the name reads like a
 * company). When nothing fires, default weakly to `partnership` (UI "B2B
 * Partner") and flag for the tray.
 */
export function classifyAccount(input: ClassifyAccountInput): ClassifyAccountResult {
  const name = input.companyName ?? ''
  const domain = domainOf(input.contactEmail, input.website)

  // 1. Domain is the strongest signal.
  if (domain) {
    for (const { re, label } of SCHOOL_DOMAIN_PATTERNS) {
      if (re.test(domain)) {
        return { kind: 'school', needsClassification: false, confidence: 0.95, reason: label }
      }
    }
  }

  // 2. Name signals. Count both sides; the stronger side wins.
  const schoolHits = SCHOOL_NAME_PATTERNS.filter((p) => p.re.test(name))
  const partnerHits = PARTNER_NAME_PATTERNS.filter((p) => p.re.test(name))

  if (schoolHits.length > 0 && schoolHits.length >= partnerHits.length) {
    // A clear school word with no competing company word is confident.
    const confidence = partnerHits.length === 0 ? 0.85 : 0.7
    return {
      kind: 'school',
      needsClassification: confidence < CONFIDENT_THRESHOLD,
      confidence,
      reason: schoolHits[0]!.label,
    }
  }

  if (partnerHits.length > 0 && partnerHits.length > schoolHits.length) {
    const confidence = schoolHits.length === 0 ? 0.8 : 0.65
    return {
      kind: 'partnership',
      needsClassification: confidence < CONFIDENT_THRESHOLD,
      confidence,
      reason: partnerHits[0]!.label,
    }
  }

  // 3. No signal → tray. Weak default to B2B partner (the safer bucket: a
  //    mis-filed partner is less surprising than a mis-filed "school").
  return {
    kind: 'partnership',
    needsClassification: true,
    confidence: 0,
    reason: 'no clear school or partner signal — needs review',
  }
}
