// Shared types + Zod schemas for the weekly-webinar system. Pure, no I/O.
// Imported by the tRPC router (input validation) and the jobs (scheduling).

import { z } from 'zod'

/** Canonical subject handles. Strings, not a DB enum, so admins can extend. */
export const WEBINAR_SUBJECTS = ['biology', 'chemistry', 'physics', 'maths'] as const
export type WebinarSubject = (typeof WEBINAR_SUBJECTS)[number]

export const WEBINAR_LEVELS = ['gcse', 'a_level'] as const
export type WebinarLevel = (typeof WEBINAR_LEVELS)[number]

/** Pretty labels for UI + emails. */
export const SUBJECT_LABEL: Record<string, string> = {
  biology: 'Biology',
  chemistry: 'Chemistry',
  physics: 'Physics',
  maths: 'Maths',
}

export const LEVEL_LABEL: Record<WebinarLevel, string> = {
  gcse: 'GCSE',
  a_level: 'A-Level',
}

export function subjectLabel(subject: string): string {
  return SUBJECT_LABEL[subject] ?? subject.charAt(0).toUpperCase() + subject.slice(1)
}

export function levelLabel(level: WebinarLevel): string {
  return LEVEL_LABEL[level] ?? level
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

export const webinarSubjectSchema = z.string().trim().toLowerCase().min(1).max(40)
export const webinarLevelSchema = z.enum(WEBINAR_LEVELS)

/** One subject+level the matcher detected in a piece of Stripe text. */
export interface DetectedClass {
  subject: WebinarSubject
  level: WebinarLevel
  /** 0..1. Deterministic matches with both subject and level are ~0.95. */
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
