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

// 0=Mon..6=Sun, matched by stem so "Saturday", "Saturdays", "Sat", "every
// saturday", "sat 9am" all resolve. Order is irrelevant — stems are distinct.
const WEEKDAY_STEMS: Array<[string, number]> = [
  ['mon', 0],
  ['tue', 1],
  ['wed', 2],
  ['thu', 3],
  ['fri', 4],
  ['sat', 5],
  ['sun', 6],
]

/** Weekday name → 0=Mon..6=Sun, or null. Tolerant of plurals/embedded text. */
export function weekdayToIndex(name: string): number | null {
  const s = name.trim().toLowerCase()
  if (!s) return null
  for (const [stem, idx] of WEEKDAY_STEMS) {
    if (s.includes(stem)) return idx
  }
  return null
}

/**
 * Parse a start time to minutes-from-midnight. Tolerant: "18:00", "18.00",
 * "6:30pm", "6.30 pm", "9am", "9 am", "noon", "midnight", and ranges like
 * "6-8pm" / "9am-1pm" (takes the start, applying a trailing meridiem). null if
 * no time is found.
 */
export function parseStartMinute(value: string): number | null {
  const s = value.trim().toLowerCase()
  if (!s) return null
  if (/\bnoon\b|\bmidday\b/.test(s)) return 12 * 60
  if (/\bmidnight\b/.test(s)) return 0
  // A trailing meridiem applies to the start of a range ("6-8pm" → 6pm).
  const meridiemAll = /(am|pm)/.exec(s)?.[1]
  // First time token: hour, optional :/./h minutes, optional own meridiem.
  const m = /(\d{1,2})\s*(?:[:.h]\s*(\d{2}))?\s*(am|pm)?/.exec(s)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const meridiem = m[3] ?? meridiemAll
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

/** Nullable free-text — the AI/tabular sources are deliberately permissive, so
 *  every field can be missing or null and is validated/clamped here. */
type Loose = string | null | undefined

/** The (schema-validated but permissive) input shape this module consumes. */
export interface TimetableImportAiShape {
  cohort?: { name?: Loose; startsOn?: Loose; endsOn?: Loose } | null
  holidays?: Array<{ name?: Loose; startsOn?: Loose; endsOn?: Loose }> | null
  classes?: Array<{
    subject?: Loose
    level?: Loose
    title?: Loose
    day?: Loose
    startTime?: Loose
    durationMins?: number | null
    weeks?: Array<{ weekNumber?: number | null; topic?: Loose }> | null
  }> | null
  note?: Loose
}

/** True when `v` is a non-empty ISO YYYY-MM-DD string. */
function isIsoDate(v: Loose): v is string {
  return typeof v === 'string' && ISO_DATE.test(v)
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

function cleanWeeks(
  weeks: Array<{ weekNumber?: number | null; topic?: Loose }> | null | undefined,
): PlannedWeek[] {
  if (!weeks) return []
  const out: PlannedWeek[] = []
  for (const w of weeks) {
    const topic = (w.topic ?? '').trim()
    const n = Math.trunc(Number(w.weekNumber))
    if (!topic || !Number.isFinite(n) || n < 1 || n > 60) continue
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
  const startsOn = isIsoDate(ai.cohort?.startsOn) ? ai.cohort!.startsOn : null
  const endsOn = isIsoDate(ai.cohort?.endsOn) ? ai.cohort!.endsOn : null

  const holidays: PlannedHoliday[] = []
  for (const h of ai.holidays ?? []) {
    const name = (h.name ?? '').trim().slice(0, 80)
    if (!name || !isIsoDate(h.startsOn) || !isIsoDate(h.endsOn)) {
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

    const subjectLabelClamped = subject.label.slice(0, 60)
    const levelLabelClamped = level.label.slice(0, 60)
    classes.push({
      subjectHandle: subject.handle,
      subjectLabel: subjectLabelClamped,
      subjectIsNew: subject.isNew,
      levelHandle: level.handle,
      levelLabel: levelLabelClamped,
      levelIsNew: level.isNew,
      title: (c.title ?? '').trim().slice(0, 120) || `${subjectLabelClamped} ${levelLabelClamped}`.slice(0, 120),
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

/* -------------------------------------------------------------------------- */
/* Deterministic tabular parser (structured CSV / spreadsheet export)          */
/* -------------------------------------------------------------------------- */
//
// Most real timetables are a clean spreadsheet: one row per week with Subject,
// Level, Week, Date, Day, Start, Title columns (+ "No class" rows for breaks).
// That parses perfectly WITHOUT AI — so we try this first (rules-first, §3/§18)
// and only reach for the AI structurer when the input isn't a recognisable
// table (a prose paste, an odd PDF). No clock, no I/O.

/** RFC-4180-ish parse: handles quoted fields with embedded commas/newlines. */
export function parseDelimitedRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      field = ''
      row = []
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0))
}

/** Pick the delimiter the header row most likely uses (comma / tab / semicolon). */
function detectDelimiter(firstLine: string): string {
  const counts: Array<[string, number]> = [
    [',', (firstLine.match(/,/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0]![1] > 0 ? counts[0]![0] : ','
}

type ColumnRole =
  | 'subject'
  | 'level'
  | 'week'
  | 'date'
  | 'day'
  | 'start'
  | 'title'
  | 'type'
  | 'notes'
  | 'runs'

/** Map a header cell to a known column role (or null if unrecognised). */
function headerRole(raw: string): ColumnRole | null {
  const h = raw.trim().toLowerCase()
  if (!h) return null
  if (/^subjects?$/.test(h)) return 'subject'
  if (/^(level|tier|qualification)$/.test(h)) return 'level'
  if (/^(week|wk|week\s*(no|number|#)?)$/.test(h)) return 'week'
  if (/^date$/.test(h)) return 'date'
  if (/^(day|weekday)$/.test(h)) return 'day'
  if (/^(start|start\s*time|time|from)$/.test(h)) return 'start'
  if (/^(title|topic|lesson|content|theme)$/.test(h)) return 'title'
  if (/^(type|category|kind)$/.test(h)) return 'type'
  if (/^(notes?|comment|comments)$/.test(h)) return 'notes'
  if (/^(runs?|running|active|on)$/.test(h)) return 'runs'
  return null
}

const TEACHING_NO = /\b(no\s*class|cancelled|canceled|holiday|break|half\s*term|no\s*session)\b/i

/** Drop a redundant level token from a subject cell: "A-level Biology" + level
 *  "A-level" → "Biology". Leaves the subject as-is when nothing meaningful is
 *  left (e.g. a "UCAT" subject whose level is also "UCAT"). */
function stripLevelToken(subject: string, level: string): string {
  const subj = subject.trim()
  const lv = level.trim()
  if (!lv) return subj
  const re = new RegExp(`\\b${lv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  const stripped = subj.replace(re, '').replace(/\s{2,}/g, ' ').trim()
  return stripped.length > 0 ? stripped : subj
}

/** Derive a "2026/2027"-style name from the spread of dates, else single year. */
function cohortNameFromDates(dates: string[]): string {
  const years = dates
    .map((d) => Number(d.slice(0, 4)))
    .filter((y) => Number.isFinite(y) && y > 2000)
  if (years.length === 0) return ''
  const min = Math.min(...years)
  const max = Math.max(...years)
  return min === max ? String(min) : `${min}/${max}`
}

/**
 * Parse a structured timetable table into the import shape. Returns null when
 * the text is not a recognisable table (no header row mapping to our columns),
 * so the caller can fall back to the AI structurer.
 *
 * Teaching weeks are renumbered sequentially by date (so they line up with the
 * holiday-aware session numbering the rest of the system computes), and "No
 * class" rows become cohort holidays.
 */
export function parseTabularTimetable(text: string): TimetableImportAiShape | null {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = detectDelimiter(firstLine)
  const rows = parseDelimitedRows(text, delimiter)
  if (rows.length < 2) return null

  const header = rows[0]!.map(headerRole)
  const roleAt = (role: ColumnRole): number => header.indexOf(role)
  // Need enough structure to be confident this is a timetable table.
  const hasTitle = roleAt('title') >= 0
  const hasDate = roleAt('date') >= 0
  const hasSubject = roleAt('subject') >= 0
  if (!(hasTitle && (hasDate || roleAt('week') >= 0)) && !(hasSubject && hasDate)) {
    return null
  }

  const cell = (row: string[], role: ColumnRole): string => {
    const idx = roleAt(role)
    return idx >= 0 ? (row[idx] ?? '').trim() : ''
  }

  interface Group {
    subject: string
    level: string
    day: string
    start: string
    teaching: Array<{ date: string; topic: string }>
  }
  const groups = new Map<string, Group>()
  const holidays: TimetableImportAiShape['holidays'] = []
  const allDates: string[] = []

  for (const row of rows.slice(1)) {
    const subject = cell(row, 'subject')
    const level = cell(row, 'level')
    const date = cell(row, 'date')
    const day = cell(row, 'day')
    const start = cell(row, 'start')
    const title = cell(row, 'title')
    const type = cell(row, 'type')
    const notes = cell(row, 'notes')
    const runs = cell(row, 'runs')

    if (ISO_DATE.test(date)) allDates.push(date)

    const isNoClass =
      /^(no|n)$/i.test(runs) || TEACHING_NO.test(type) || TEACHING_NO.test(title)
    if (isNoClass) {
      if (ISO_DATE.test(date)) {
        holidays!.push({ name: notes || title || 'Break', startsOn: date, endsOn: date })
      }
      continue
    }

    const cleanSubject = stripLevelToken(subject, level)
    const key = `${cleanSubject.toLowerCase()}|${level.toLowerCase()}`
    let g = groups.get(key)
    if (!g) {
      g = { subject: cleanSubject, level, day, start, teaching: [] }
      groups.set(key, g)
    }
    if (!g.day && day) g.day = day
    if (!g.start && start) g.start = start
    const topic = title || notes
    if (topic) g.teaching.push({ date: ISO_DATE.test(date) ? date : '', topic })
  }

  const classes: TimetableImportAiShape['classes'] = []
  for (const g of groups.values()) {
    if (!g.subject && !g.level) continue
    // Order by date when available so the sequential week numbers match the
    // holiday-aware session numbering computeSessions() produces.
    const ordered = g.teaching.some((t) => t.date)
      ? [...g.teaching].sort((a, b) => a.date.localeCompare(b.date))
      : g.teaching
    classes.push({
      subject: g.subject || 'Class',
      level: g.level || g.subject || 'Class',
      day: g.day,
      startTime: g.start,
      weeks: ordered.map((t, i) => ({ weekNumber: i + 1, topic: t.topic })),
    })
  }
  if (classes.length === 0) return null

  // Dedupe holidays by name+date.
  const seenHol = new Set<string>()
  const uniqueHolidays = (holidays ?? []).filter((h) => {
    const k = `${(h.name ?? '').toLowerCase()}|${h.startsOn ?? ''}`
    return seenHol.has(k) ? false : (seenHol.add(k), true)
  })

  const sortedDates = [...allDates].sort()
  return {
    cohort: {
      name: cohortNameFromDates(allDates),
      startsOn: sortedDates[0] ?? null,
      endsOn: sortedDates[sortedDates.length - 1] ?? null,
    },
    holidays: uniqueHolidays,
    classes,
  }
}
