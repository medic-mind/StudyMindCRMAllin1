// Peak-times windows for the Aircall analytics (CLAUDE.md §10). Pure domain
// logic — no I/O. A peak window marks a recurring season (month/day range), a
// set of weekdays, and an hour band as "peak". The classification basis (which
// timezone the {month, day, dow, hour} parts come from) is the caller's job;
// these helpers only compare already-extracted calendar parts so they stay
// pure and unit-testable. The report extracts parts on the Europe/London clock.

import { z } from 'zod'

/** A configured peak window (DB row mapped to the domain shape). */
export interface PeakWindowDef {
  id: string
  name: string
  /** Season start/end as month (1-12) + day (1-31). */
  startMonth: number
  startDay: number
  endMonth: number
  endDay: number
  /** Peak weekdays: 0 = Monday … 6 = Sunday. */
  daysOfWeek: ReadonlyArray<number>
  /** Peak hour band on a 24h clock: [startHour, endHour). */
  startHour: number
  endHour: number
  /** null = recurs every year; set = only this calendar year. */
  year: number | null
  /** Display colour token, e.g. `amber-500`. */
  color: string
}

/** Calendar parts of a single timestamp, extracted in the report's timezone. */
export interface PeakInstant {
  year: number
  /** 1-12 */
  month: number
  /** 1-31 */
  day: number
  /** 0 = Monday … 6 = Sunday */
  dow: number
  /** 0-23 */
  hour: number
}

/** Encodes month/day as a comparable ordinal (Aug 15 → 815). */
function ordinal(month: number, day: number): number {
  return month * 100 + day
}

/** True when `t`'s month/day falls inside the window's season, handling a
 * season that wraps the year boundary (start > end, e.g. Nov → Feb). */
export function inSeason(w: PeakWindowDef, month: number, day: number): boolean {
  const start = ordinal(w.startMonth, w.startDay)
  const end = ordinal(w.endMonth, w.endDay)
  const d = ordinal(month, day)
  return start <= end ? d >= start && d <= end : d >= start || d <= end
}

/** Does a single instant fall within this peak window? */
export function instantMatchesWindow(w: PeakWindowDef, t: PeakInstant): boolean {
  if (w.year != null && w.year !== t.year) return false
  if (w.endHour <= w.startHour) return false
  if (t.hour < w.startHour || t.hour >= w.endHour) return false
  if (!w.daysOfWeek.includes(t.dow)) return false
  return inSeason(w, t.month, t.day)
}

/** Is the instant peak under any of the configured windows? */
export function isPeakInstant(
  windows: ReadonlyArray<PeakWindowDef>,
  t: PeakInstant,
): boolean {
  return windows.some((w) => instantMatchesWindow(w, t))
}

// --- Display helpers (shared by the report UI + the PDF export) --------------

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const
const DOW_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

function monthShort(m: number): string {
  return MONTHS_SHORT[m - 1] ?? String(m)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export interface PeakWindowLabels {
  season: string
  days: string
  hours: string
  year: string
}

/** Human labels for a window — `Aug 15 – Sep 30`, `Weekdays`, `16:00 – 20:00`,
 * `Every year`. Pure so the report and the PDF render identical text. */
export function describePeakWindow(w: PeakWindowDef): PeakWindowLabels {
  const season = `${monthShort(w.startMonth)} ${w.startDay} – ${monthShort(w.endMonth)} ${w.endDay}`

  const sorted = [...new Set(w.daysOfWeek)].sort((a, b) => a - b)
  let days: string
  if (sorted.length === 7) days = 'Every day'
  else if (sorted.length === 5 && sorted.every((d) => d <= 4)) days = 'Weekdays'
  else if (sorted.length === 2 && sorted[0] === 5 && sorted[1] === 6) days = 'Weekends'
  else days = sorted.map((d) => DOW_SHORT[d] ?? String(d)).join(', ')

  const hours = `${pad2(w.startHour)}:00 – ${pad2(w.endHour)}:00`
  const year = w.year == null ? 'Every year' : String(w.year)
  return { season, days, hours, year }
}

// --- Validation --------------------------------------------------------------

/** Create/update input for a peak window. `endHour > startHour` is enforced by
 * the router (kept off the schema so it can be `.merge`d for the update path). */
export const PeakWindowInput = z.object({
  name: z.string().trim().min(1).max(80),
  startMonth: z.number().int().min(1).max(12),
  startDay: z.number().int().min(1).max(31),
  endMonth: z.number().int().min(1).max(12),
  endDay: z.number().int().min(1).max(31),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  year: z.number().int().min(2000).max(2100).nullable().default(null),
  color: z.string().trim().min(1).max(32).default('amber-500'),
})
export type PeakWindowInput = z.infer<typeof PeakWindowInput>

export const PeakWindowUpdateInput = z.object({ id: z.string() }).merge(PeakWindowInput)
export type PeakWindowUpdateInput = z.infer<typeof PeakWindowUpdateInput>
