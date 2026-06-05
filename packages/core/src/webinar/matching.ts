// Deterministic subject + level matcher for weekly-webinar enrolment.
//
// This is the AUTHORITATIVE matcher (CLAUDE.md §3, §18: rules first, AI only
// advises). It reads any Stripe-derived text — product name, price nickname,
// subscription description, or the customer name (subjects sometimes appear
// there) — and returns the subject+level pairs it can find. The AI organiser
// (packages/ai webinar-class-match) is only consulted when this returns
// nothing, and its suggestions always land as `pending_review`.

import type { DetectedClass, WebinarLevel, WebinarSubject } from './types'

interface SubjectRule {
  subject: WebinarSubject
  /** Ordered: more specific spellings first so we match whole words. */
  patterns: RegExp[]
  /** If present and matched, the subject is rejected (e.g. "literature"). */
  exclude?: RegExp
}

// Word-boundary patterns. `maths` also matches American "math" and the long
// form "mathematics". We deliberately do NOT match the bare letters of an
// element symbol etc — only real subject words.
const SUBJECT_RULES: SubjectRule[] = [
  { subject: 'biology', patterns: [/\bbiology\b/, /\bbio\b/] },
  { subject: 'chemistry', patterns: [/\bchemistry\b/, /\bchem\b/] },
  { subject: 'physics', patterns: [/\bphysics\b/, /\bphys\b/] },
  { subject: 'maths', patterns: [/\bmaths?\b/, /\bmathematics\b/] },
  // English Language (the live product). Match "english language" / "english
  // lang" / a bare "english" — but not "english literature", handled below.
  {
    subject: 'english_language',
    patterns: [/\benglish\s*lang(uage)?\b/, /\benglish\b/],
    // Don't claim "English Literature" (a different product we don't run as a
    // class) unless "language" is explicitly present.
    exclude: /\bliterature\b/,
  },
]

// Year groups are a strong level signal: Y12/Y13 (sixth form) → A-Level,
// Y10/Y11 → GCSE. Listed before the generic patterns so they take precedence.
const A_LEVEL = /\b(a[-_\s]?level|a2|as[-_\s]?level|ks5|sixth[-\s]?form|year\s?1[23]|y1[23])\b/
const GCSE = /\b(gcse|ks4|year\s?1[01]|y1[01]|igcse)\b/

/** Normalise to lower-case with collapsed whitespace for matching. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Detect the level once for a block of text. Returns the level plus a flag for
 * whether it was explicit (drives confidence). When neither GCSE nor A-Level is
 * mentioned we default to `a_level` (the more common weekly-class product) but
 * mark it non-explicit so the enrolment lands in review.
 */
function detectLevel(text: string): { level: WebinarLevel; explicit: boolean } {
  if (A_LEVEL.test(text)) return { level: 'a_level', explicit: true }
  if (GCSE.test(text)) return { level: 'gcse', explicit: true }
  return { level: 'a_level', explicit: false }
}

/**
 * Detect every subject+level the text describes. A single subscription line can
 * legitimately cover more than one subject ("Biology + Chemistry GCSE"), so we
 * return an array. Empty when nothing matches.
 */
export function detectWebinarClasses(...texts: Array<string | null | undefined>): DetectedClass[] {
  const text = normalise(texts.filter((t): t is string => !!t).join(' '))
  if (text.length === 0) return []

  const { level, explicit } = detectLevel(text)
  const found: DetectedClass[] = []
  const seen = new Set<WebinarSubject>()

  for (const rule of SUBJECT_RULES) {
    const hit = rule.patterns.find((p) => p.test(text))
    if (!hit || seen.has(rule.subject)) continue
    // Reject on an exclusion word unless an explicit strong pattern overrides
    // it (e.g. "english language" beats the "literature" guard).
    if (rule.exclude && rule.exclude.test(text) && !rule.patterns[0]!.test(text)) continue
    seen.add(rule.subject)
    // Strong match (whole subject word) scores higher than an abbreviation.
    // An explicit level is what pushes a match over the auto-enrol threshold
    // (0.8): subject-only matches always land in review.
    const strongSubject = rule.patterns[0]!.test(text)
    let confidence = strongSubject ? 0.6 : 0.4
    if (explicit) confidence += 0.3
    confidence = Math.min(1, Number(confidence.toFixed(2)))
    const levelWord = explicit ? (level === 'a_level' ? 'A-Level' : 'GCSE') : 'level assumed A-Level'
    found.push({
      subject: rule.subject,
      level,
      confidence,
      reason: `Matched "${rule.subject}" (${levelWord}) in "${truncate(text)}"`,
    })
  }

  return found
}

/** Best single match (highest confidence) or null. Convenience for callers. */
export function matchWebinarClass(...texts: Array<string | null | undefined>): DetectedClass | null {
  const all = detectWebinarClasses(...texts)
  if (all.length === 0) return null
  return all.reduce((best, c) => (c.confidence > best.confidence ? c : best))
}

/** Confidence at or above this auto-activates; below lands in review. */
export const AUTO_ENROLL_CONFIDENCE = 0.8

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
