// Pure logic for the "import a whole timetable" flow (CLAUDE.md §47). A manager
// uploads one master timetable (PDF / CSV / paste); AI extracts the academic
// year, its holidays, and every weekly group class (subject + level + day +
// time + weekly topics). This module turns that raw AI shape into a clean,
// validated PLAN the UI shows for human confirmation before anything is written
// (§3 — AI suggests, humans confirm). No I/O, no clock of its own.
//
// Subject/level labels are resolved against the operator catalogues
// (WebinarSubjectOption / WebinarLevelOption); anything the timetable names that
// isn't in a catalogue yet is flagged `isNew` so the apply step can find-or-
// create it inline — the same "create subjects inline" rule the New-class form
// already follows.

import { WEEKDAY_LABEL } from './types'

/** Normalise a label into a stable handle: "A-Level" → "a_level". Shared with
 *  the catalogue router so a label imported here resolves to the same row. */
export function toWebinarHandle(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

const WEEKDAY_ALIASES: Record<string, number> = {
  monday: 0,
  mon: 0,
  tuesday: 1,
  tue: 1,
  tues: 1,
  wednesday: 2,
  wed: 2,
  weds: 2,
  thursday: 3,
  thu: 3,
  thur: 3,
  thurs: 3,
  friday: 4,
  fri: 4,
  saturday: 5,
  sat: 5,
  sunday: 6,
  sun: 6,
}

/** Weekday name → 0=Mon..6=Sun, or null if unrecognised. */
export function weekdayToIndex(name: string): number | null {
  const key = name.trim().toLowerCase().replace(/[^a-z]/g, '')
  return key in WEEKDAY_ALIASES ? WEEKDAY_ALIASES[key]! : null
}

/** "18:00" / "6:30pm" / "9am" → minutes from local midnight, or null. */
export function parseStartMinute(value: string): number | null {
  const s = value.trim().toLowerCase()
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const meridiem = m[3]
  if (minute > 59) return null
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    if (meridiem === 'pm' && hour !== 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
  }
  if (hour > 23) return null
  return hour * 60 + minute
}

/** 1080 → "18:00". */
export function minuteToTimeLabel(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface CatalogueOption {
  handle: string
  label: string
  aliases?: string[]
}

export interface ResolvedHandle {
  handle: string
  label: string
  /** True when no catalogue row matched — the apply step creates it. */
  isNew: boolean
}

/**
 * Resolve a free-text subject/level label to a catalogue handle. Matches on
 * handle, label, or alias (case-insensitive); otherwise synthesises a handle
 * and flags it as new so it is created on apply.
 */
export function resolveCatalogueHandle(
  rawLabel: string,
  options: CatalogueOption[],
): ResolvedHandle {
  const needle = rawLabel.trim().toLowerCase()
  const synthHandle = toWebinarHandle(rawLabel)
  for (const opt of options) {
    const haystack = [opt.handle, opt.label, ...(opt.aliases ?? [])].map((s) =>
      s.trim().toLowerCase(),
    )
    if (haystack.includes(needle) || opt.handle === synthHandle) {
      return { handle: opt.handle, label: opt.label, isNew: false }
    }
  }
  return { handle: synthHandle, label: rawLabel.trim(), isNew: true }
}

/* -------------------------------------------------------------------------- */
/* AI shape → plan                                                             */
/* -------------------------------------------------------------------------- */

/** The (already schema-validated) AI output shape this module consumes. */
export interface TimetableImportAiShape {
  cohort: { name: string; startsOn?: string | null; endsOn?: string | null }
  holidays?: Array<{ name: string; startsOn: string; endsOn: string }>
  classes: Array<{
    subject: string
    level: string
    title?: string | null
    day: string
    startTime: string
    durationMins?: number | null
    weeks?: Array<{ weekNumber: number; topic: string }>
  }>
  note?: string
}

export interface PlannedWeek {
  weekNumber: number
  topic: string
}

export interface PlannedClass {
  subjectHandle: string
  subjectLabel: string
  subjectIsNew: boolean
  levelHandle: string
  levelLabel: string
  levelIsNew: boolean
  title: string
  dayOfWeek: number
  dayLabel: string
  startMinute: number
  timeLabel: string
  durationMins: number
  weeks: PlannedWeek[]
}

export interface PlannedHoliday {
  name: string
  startsOn: string
  endsOn: string
}

export interface TimetablePlan {
  cohort: {
    name: string
    startsOn: string | null
    endsOn: string | null
  }
  holidays: PlannedHoliday[]
  classes: PlannedClass[]
  /** Human-readable issues (rows dropped, dates ignored) for the reviewer. */
  warnings: string[]
}

export interface BuildTimetablePlanOptions {
  subjects: CatalogueOption[]
  levels: CatalogueOption[]
}

function cleanWeeks(weeks: Array<{ weekNumber: number; topic: string }> | undefined): PlannedWeek[] {
  if (!weeks) return []
  const out: PlannedWeek[] = []
  for (const w of weeks) {
    const topic = (w.topic ?? '').trim()
    const n = Math.trunc(w.weekNumber)
    if (!topic || n < 1 || n > 60) continue
    out.push({ weekNumber: n, topic: topic.slice(0, 300) })
  }
  // Stable order; keep the first topic seen for any duplicated week number.
  out.sort((a, b) => a.weekNumber - b.weekNumber)
  const seen = new Set<number>()
  return out.filter((w) => (seen.has(w.weekNumber) ? false : (seen.add(w.weekNumber), true)))
}

/**
 * Turn the AI output into a validated plan. Classes that lack a usable day or
 * time are dropped (with a warning) rather than guessed. Duplicate
 * subject+level pairs collapse to the first (a class is unique per cohort).
 */
export function buildTimetablePlan(
  ai: TimetableImportAiShape,
  opts: BuildTimetablePlanOptions,
): TimetablePlan {
  const warnings: string[] = []

  const cohortName = (ai.cohort?.name ?? '').trim().slice(0, 40)
  const startsOn = ai.cohort?.startsOn && ISO_DATE.test(ai.cohort.startsOn) ? ai.cohort.startsOn : null
  const endsOn = ai.cohort?.endsOn && ISO_DATE.test(ai.cohort.endsOn) ? ai.cohort.endsOn : null

  const holidays: PlannedHoliday[] = []
  for (const h of ai.holidays ?? []) {
    const name = (h.name ?? '').trim().slice(0, 80)
    if (!name || !ISO_DATE.test(h.startsOn) || !ISO_DATE.test(h.endsOn)) {
      if (name) warnings.push(`Skipped holiday "${name}" — dates were not clear.`)
      continue
    }
    if (h.endsOn < h.startsOn) {
      warnings.push(`Skipped holiday "${name}" — end date was before start.`)
      continue
    }
    holidays.push({ name, startsOn: h.startsOn, endsOn: h.endsOn })
  }

  const classes: PlannedClass[] = []
  const seenPairs = new Set<string>()
  for (const c of ai.classes ?? []) {
    const subjectRaw = (c.subject ?? '').trim()
    const levelRaw = (c.level ?? '').trim()
    if (!subjectRaw || !levelRaw) {
      warnings.push('Skipped a class with no subject or level.')
      continue
    }
    const dayOfWeek = weekdayToIndex(c.day ?? '')
    const startMinute = parseStartMinute(c.startTime ?? '')
    const subject = resolveCatalogueHandle(subjectRaw, opts.subjects)
    const level = resolveCatalogueHandle(levelRaw, opts.levels)
    const label = `${subject.label} ${level.label}`
    if (dayOfWeek == null) {
      warnings.push(`Skipped ${label} — could not read the weekday "${c.day ?? ''}".`)
      continue
    }
    if (startMinute == null) {
      warnings.push(`Skipped ${label} — could not read the start time "${c.startTime ?? ''}".`)
      continue
    }
    const pairKey = `${subject.handle}|${level.handle}`
    if (seenPairs.has(pairKey)) {
      warnings.push(`Merged a duplicate ${label} (one class per subject + level).`)
      continue
    }
    seenPairs.add(pairKey)

    const durationMins =
      c.durationMins && c.durationMins >= 15 && c.durationMins <= 480
        ? Math.trunc(c.durationMins)
        : 60

    classes.push({
      subjectHandle: subject.handle,
      subjectLabel: subject.label,
      subjectIsNew: subject.isNew,
      levelHandle: level.handle,
      levelLabel: level.label,
      levelIsNew: level.isNew,
      title: (c.title ?? '').trim().slice(0, 120) || label,
      dayOfWeek,
      dayLabel: WEEKDAY_LABEL[dayOfWeek] ?? '—',
      startMinute,
      timeLabel: minuteToTimeLabel(startMinute),
      durationMins,
      weeks: cleanWeeks(c.weeks),
    })
  }

  return {
    cohort: { name: cohortName, startsOn, endsOn },
    holidays,
    classes,
    warnings,
  }
}
