// Shared types + Zod schemas for the weekly-webinar system. Pure, no I/O.
// Imported by the tRPC router (input validation) and the jobs (scheduling).

import { z } from 'zod'

/** Canonical subject handles. Strings, not a DB enum, so admins can extend. */
export const WEBINAR_SUBJECTS = [
  'biology',
  'chemistry',
  'physics',
  'maths',
  'english_language',
] as const
export type WebinarSubject = (typeof WEBINAR_SUBJECTS)[number]

/** Built-in school levels. Other levels/types (UCAT, GAMSAT, 11+, …) are
 *  operator-managed in WebinarLevelOption — `level` is a free string. */
export const WEBINAR_LEVELS = ['gcse', 'a_level'] as const
export type WebinarLevel = (typeof WEBINAR_LEVELS)[number]

/** Pretty labels for UI + emails (fallbacks; the live label comes from the
 *  WebinarSubjectOption / WebinarLevelOption catalogue when available). */
export const SUBJECT_LABEL: Record<string, string> = {
  biology: 'Biology',
  chemistry: 'Chemistry',
  physics: 'Physics',
  maths: 'Maths',
  english_language: 'English Language',
}

export const LEVEL_LABEL: Record<string, string> = {
  gcse: 'GCSE',
  a_level: 'A-Level',
  ucat: 'UCAT',
  gamsat: 'GAMSAT',
}

/** Title-case a handle like "english_language" → "English Language". */
function titleiseHandle(handle: string): string {
  return handle
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function subjectLabel(subject: string): string {
  return SUBJECT_LABEL[subject] ?? titleiseHandle(subject)
}

export function levelLabel(level: string): string {
  return LEVEL_LABEL[level] ?? titleiseHandle(level)
}

/** 0 = Monday … 6 = Sunday (matches the CallPeakWindow convention). */
export const WEEKDAY_LABEL = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const

/** Handle-shaped string: lower-case, words joined by underscores. */
const handleSchema = z.string().trim().toLowerCase().min(1).max(40)
export const webinarSubjectSchema = handleSchema
export const webinarLevelSchema = handleSchema

/** One subject+level the matcher detected in a piece of Stripe text. Both are
 *  free-string handles from the operator catalogues. */
export interface DetectedClass {
  subject: string
  level: string
  /** 0..1. Deterministic matches with both subject and level are ~0.9. */
  confidence: number
  reason: string
}

/** A computed teaching session in a cohort (a delivered week). */
export interface WebinarSession {
  /** Sequential teaching-week number, holidays excluded. 1-based. */
  weekNumber: number
  /** Calendar date of the session (UTC midnight for that local day). */
  date: Date
}
