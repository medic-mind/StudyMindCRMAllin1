// Deterministic subject + level matcher for weekly-webinar enrolment.
//
// This is the AUTHORITATIVE matcher (CLAUDE.md §3, §18: rules first, AI only
// advises). It reads any Stripe-derived text — product name, price nickname,
// subscription description, metadata, or the customer name — and returns the
// subject+level pairs it can find. The AI organiser is only consulted when this
// returns nothing, and its suggestions always land as `pending_review`.
//
// The subject set is operator-managed (WebinarSubjectOption): the five live
// subjects ship with curated keyword rules below, and admins can add more from
// the UI. For an added subject we synthesise a rule from its label + aliases via
// `buildSubjectRules`, so a brand-new subject is matchable with no code change.

import type { DetectedClass } from './types'

export interface SubjectRule {
  /** Stable subject handle stored on WebinarClass.subject. */
  subject: string
  /** Ordered: the first (strongest) spelling first, then weaker aliases. */
  patterns: RegExp[]
  /** If present and matched, the subject is rejected (e.g. "literature"). */
  exclude?: RegExp
}

// Curated rules for the live subjects. `maths` also matches American "math" and
// the long form "mathematics".
export const BUILTIN_SUBJECT_RULES: SubjectRule[] = [
  { subject: 'biology', patterns: [/\bbiology\b/, /\bbio\b/] },
  { subject: 'chemistry', patterns: [/\bchemistry\b/, /\bchem\b/] },
  { subject: 'physics', patterns: [/\bphysics\b/, /\bphys\b/] },
  { subject: 'maths', patterns: [/\bmaths?\b/, /\bmathematics\b/] },
  // English Language (the live product). Match "english language" / "english
  // lang" / a bare "english" — but not "english literature", handled below.
  {
    subject: 'english_language',
    patterns: [/\benglish\s*lang(uage)?\b/, /\benglish\b/],
    exclude: /\bliterature\b/,
  },
]

// Year groups are a strong level signal: Y12/Y13 (sixth form) → A-Level,
// Y10/Y11 → GCSE. Kept deliberately broad because product NAMES carry the level
// in many forms ("A-Level", "A Level", "AS/A2", "KS5", "Lower Sixth", "Yr13").
const A_LEVEL =
  /\b(a[-_\s]?levels?|a[-_\s]?lvl|a2|as[-_\s]?level|ks5|sixth[-\s]?form|(lower|upper)[-\s]?sixth|(year|yr)\s?1[23]|y1[23])\b/
const GCSE = /\b(i?gcses?|ks4|(year|yr)\s?1[01]|y1[01])\b/

export interface LevelRule {
  /** Stable level/type handle stored on WebinarClass.level. */
  level: string
  patterns: RegExp[]
}

// Curated rules for the two school levels. Other levels/types (UCAT, GAMSAT,
// 11+, …) are operator-managed (WebinarLevelOption) and get synthesised rules
// from their label + aliases via `buildLevelRules`.
export const BUILTIN_LEVEL_RULES: LevelRule[] = [
  { level: 'a_level', patterns: [A_LEVEL] },
  { level: 'gcse', patterns: [GCSE] },
]

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A whole-word, whitespace-flexible pattern for a free-text term. */
function termPattern(term: string): RegExp {
  const norm = escapeRegex(term.toLowerCase().trim()).replace(/\s+/g, '\\s+')
  return new RegExp(`\\b${norm}\\b`)
}

export function buildLevelRule(opts: {
  level: string
  label?: string
  aliases?: string[]
}): LevelRule {
  const builtin = BUILTIN_LEVEL_RULES.find((r) => r.level === opts.level)
  if (builtin) return builtin
  const terms = [opts.label ?? opts.level.replace(/_/g, ' '), ...(opts.aliases ?? [])]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const patterns = terms.length > 0 ? terms.map(termPattern) : [termPattern(opts.level)]
  return { level: opts.level, patterns }
}

/** Build the level rule list for the operator's level catalogue. */
export function buildLevelRules(
  options: Array<{ handle: string; label?: string; aliases?: string[] }>,
): LevelRule[] {
  if (options.length === 0) return BUILTIN_LEVEL_RULES
  return options.map((o) => buildLevelRule({ level: o.handle, label: o.label, aliases: o.aliases }))
}

/**
 * Build a matcher rule for a subject. Live subjects reuse their curated rule;
 * an added subject gets a rule synthesised from its label + handle + aliases.
 */
export function buildSubjectRule(opts: {
  subject: string
  label?: string
  aliases?: string[]
}): SubjectRule {
  const builtin = BUILTIN_SUBJECT_RULES.find((r) => r.subject === opts.subject)
  if (builtin) return builtin
  const terms = [opts.label ?? opts.subject.replace(/_/g, ' '), ...(opts.aliases ?? [])]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const patterns = terms.length > 0 ? terms.map(termPattern) : [termPattern(opts.subject)]
  return { subject: opts.subject, patterns }
}

/** Build the rule list for the operator's subject catalogue. */
export function buildSubjectRules(
  options: Array<{ handle: string; label?: string; aliases?: string[] }>,
): SubjectRule[] {
  if (options.length === 0) return BUILTIN_SUBJECT_RULES
  return options.map((o) => buildSubjectRule({ subject: o.handle, label: o.label, aliases: o.aliases }))
}

/** Normalise to lower-case with collapsed whitespace for matching. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Detect the level/type from the text against the given level rules (first rule
 * to match wins, so order them most-specific first). Returns null when no level
 * is mentioned — the deterministic matcher then declines to guess (safer in a
 * world with GCSE / A-Level / UCAT / GAMSAT / …); the AI fallback or a human
 * places it instead.
 */
function detectLevel(text: string, levelRules: LevelRule[]): string | null {
  for (const rule of levelRules) {
    if (rule.patterns.some((p) => p.test(text))) return rule.level
  }
  return null
}

function detectWith(
  subjectRules: SubjectRule[],
  levelRules: LevelRule[],
  rawText: string,
): DetectedClass[] {
  const text = normalise(rawText)
  if (text.length === 0) return []
  const level = detectLevel(text, levelRules)
  // No explicit level → don't guess which class; leave to AI / manual review.
  if (!level) return []
  const found: DetectedClass[] = []
  const seen = new Set<string>()

  for (const rule of subjectRules) {
    const hit = rule.patterns.find((p) => p.test(text))
    if (!hit || seen.has(rule.subject)) continue
    // Reject on an exclusion word unless the strong pattern overrides it
    // (e.g. "english language" beats the "literature" guard).
    if (rule.exclude && rule.exclude.test(text) && !rule.patterns[0]!.test(text)) continue
    seen.add(rule.subject)
    const strongSubject = rule.patterns[0]!.test(text)
    const confidence = Math.min(1, Number((strongSubject ? 0.9 : 0.7).toFixed(2)))
    found.push({
      subject: rule.subject,
      level,
      confidence,
      reason: `Matched "${rule.subject}" + "${level}" in "${truncate(text)}"`,
    })
  }
  return found
}

/**
 * Detect every subject+level the text describes using the built-in subject and
 * level rules. A single subscription line can cover more than one subject, so we
 * return an array. Empty when nothing matches (no subject, or no explicit level).
 */
export function detectWebinarClasses(...texts: Array<string | null | undefined>): DetectedClass[] {
  return detectWith(
    BUILTIN_SUBJECT_RULES,
    BUILTIN_LEVEL_RULES,
    texts.filter((t): t is string => !!t).join(' '),
  )
}

/** As `detectWebinarClasses` but against the operator's subject + level catalogue. */
export function detectWebinarClassesWithRules(
  opts: { subjectRules: SubjectRule[]; levelRules?: LevelRule[] },
  texts: Array<string | null | undefined>,
): DetectedClass[] {
  return detectWith(
    opts.subjectRules,
    opts.levelRules ?? BUILTIN_LEVEL_RULES,
    texts.filter((t): t is string => !!t).join(' '),
  )
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
