// Pure scheduling for weekly webinars. No I/O, no clock reads of its own —
// callers pass `now` so tests stay deterministic (CLAUDE.md §30).
//
// All wall-clock slots are stored as (dayOfWeek, startMinute, IANA timezone).
// We compute the list of teaching sessions across a cohort, skipping holidays,
// then turn a session's calendar date + start minute into a precise UTC instant
// (DST-correct) so the dispatcher knows exactly when to send.

import type { WebinarSession } from './types'

const DAY_MS = 24 * 60 * 60 * 1000

interface HolidayRange {
  startsOn: Date
  endsOn: Date
}

/** UTC calendar-day key (yyyy-mm-dd) for comparing dates without tz drift. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Midnight UTC for the same calendar day as `d`. */
function toUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** Is the calendar day of `date` inside any holiday range (inclusive)? */
export function isHoliday(date: Date, holidays: HolidayRange[]): boolean {
  const k = dayKey(date)
  return holidays.some((h) => dayKey(h.startsOn) <= k && k <= dayKey(h.endsOn))
}

/**
 * All teaching sessions in [cohortStart, cohortEnd] that fall on `dayOfWeek`
 * (0=Mon..6=Sun) and are not inside a holiday. Week numbers are sequential over
 * delivered sessions (a holiday week does not consume a number).
 */
export function computeSessions(
  cohortStart: Date,
  cohortEnd: Date,
  dayOfWeek: number,
  holidays: HolidayRange[] = [],
): WebinarSession[] {
  const start = toUtcMidnight(cohortStart)
  const end = toUtcMidnight(cohortEnd)
  // JS getUTCDay: 0=Sun..6=Sat. Convert our 0=Mon..6=Sun to that scheme.
  const targetJsDay = (dayOfWeek + 1) % 7
  // Advance to the first matching weekday on or after the cohort start.
  let cursor = start
  while (cursor.getUTCDay() !== targetJsDay) {
    cursor = new Date(cursor.getTime() + DAY_MS)
  }
  const sessions: WebinarSession[] = []
  let week = 0
  for (; cursor.getTime() <= end.getTime(); cursor = new Date(cursor.getTime() + 7 * DAY_MS)) {
    if (isHoliday(cursor, holidays)) continue
    week += 1
    sessions.push({ weekNumber: week, date: new Date(cursor) })
  }
  return sessions
}

/* -------------------------------------------------------------------------- */
/* Timezone-correct wall-clock → UTC                                          */
/* -------------------------------------------------------------------------- */

/** Offset (localWall − UTC) in minutes for `instant` in `timeZone`. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = dtf.formatToParts(instant)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0')
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return Math.round((asUtc - instant.getTime()) / 60000)
}

/**
 * The exact UTC instant for a local wall-clock time in `timeZone`. Handles DST
 * by resolving the offset at the candidate instant and re-checking once (the
 * standard two-pass technique).
 */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string,
): Date {
  const wallMs = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60)
  const off1 = tzOffsetMinutes(new Date(wallMs), timeZone)
  let utc = new Date(wallMs - off1 * 60000)
  const off2 = tzOffsetMinutes(utc, timeZone)
  if (off2 !== off1) utc = new Date(wallMs - off2 * 60000)
  return utc
}

/** The UTC start instant of a session given its date, start minute and tz. */
export function sessionStartInstant(
  session: WebinarSession,
  startMinute: number,
  timeZone: string,
): Date {
  const d = session.date
  return zonedWallTimeToUtc(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    startMinute,
    timeZone,
  )
}

/** When the weekly email for a session should go out. */
export function sendAtFor(sessionStart: Date, sendOffsetHours: number): Date {
  return new Date(sessionStart.getTime() - sendOffsetHours * 60 * 60 * 1000)
}

export interface DueSession {
  session: WebinarSession
  startsAt: Date
  sendAt: Date
}

/**
 * Sessions whose send time has arrived but whose start is still in the future,
 * within a look-back window (so a missed cron run still catches them). Used by
 * the dispatcher to decide what to email now.
 */
export function dueSessions(
  sessions: WebinarSession[],
  startMinute: number,
  timeZone: string,
  sendOffsetHours: number,
  now: Date,
  lookBackHours = 6,
): DueSession[] {
  const out: DueSession[] = []
  const lookBackMs = lookBackHours * 60 * 60 * 1000
  for (const session of sessions) {
    const startsAt = sessionStartInstant(session, startMinute, timeZone)
    if (startsAt.getTime() < now.getTime()) continue // session already started/past
    const sendAt = sendAtFor(startsAt, sendOffsetHours)
    if (sendAt.getTime() <= now.getTime() && sendAt.getTime() >= now.getTime() - lookBackMs) {
      out.push({ session, startsAt, sendAt })
    }
  }
  return out
}

/** The next upcoming session relative to `now`, or null. */
export function nextSession(
  sessions: WebinarSession[],
  startMinute: number,
  timeZone: string,
  now: Date,
): DueSession | null {
  let best: DueSession | null = null
  for (const session of sessions) {
    const startsAt = sessionStartInstant(session, startMinute, timeZone)
    if (startsAt.getTime() < now.getTime()) continue
    if (!best || startsAt.getTime() < best.startsAt.getTime()) {
      best = { session, startsAt, sendAt: startsAt }
    }
  }
  return best
}

/* -------------------------------------------------------------------------- */
/* Reminder send-day model (Mon/Tue by default, fully configurable)            */
/* -------------------------------------------------------------------------- */

export interface LocalCalendar {
  year: number
  month: number
  day: number
  /** 0 = Monday … 6 = Sunday. */
  weekday: number
  /** 0-23 local hour. */
  hour: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
}

/** Resolve the local calendar (date, weekday, hour) for an instant in `tz`. */
export function localCalendar(instant: Date, timeZone: string): LocalCalendar {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    hour: Number(get('hour')),
  }
}

/** The UTC-midnight calendar dates for Monday..Sunday of the local week of `now`. */
export function localWeekRange(now: Date, timeZone: string): { monday: Date; sunday: Date } {
  const cal = localCalendar(now, timeZone)
  const todayUtc = Date.UTC(cal.year, cal.month - 1, cal.day)
  const monday = new Date(todayUtc - cal.weekday * DAY_MS)
  const sunday = new Date(monday.getTime() + 6 * DAY_MS)
  return { monday, sunday }
}

/** The session that falls in the same local week as `now`, or null. */
export function sessionForLocalWeek(
  sessions: WebinarSession[],
  now: Date,
  timeZone: string,
): WebinarSession | null {
  const { monday, sunday } = localWeekRange(now, timeZone)
  const lo = dayKey(monday)
  const hi = dayKey(sunday)
  return sessions.find((s) => lo <= dayKey(s.date) && dayKey(s.date) <= hi) ?? null
}

/**
 * Whether `now` is on a configured reminder day at/after the configured local
 * send hour. Returns the active reminder weekday (0=Mon..6=Sun) when due, else
 * null. The dispatcher uses the weekday as part of the idempotency key so each
 * reminder day sends at most once.
 */
export function reminderDayNow(
  now: Date,
  timeZone: string,
  sendDaysOfWeek: number[],
  sendHourLocal: number,
): number | null {
  const cal = localCalendar(now, timeZone)
  if (!sendDaysOfWeek.includes(cal.weekday)) return null
  if (cal.hour < sendHourLocal) return null
  return cal.weekday
}

/**
 * Where the term is right now for a class. `in_week` = there is a session in
 * the current local week; `not_started` = the term hasn't begun (date points at
 * the first session); `between` = a gap/holiday week (date points at the next
 * session); `ended` = the term is over.
 */
export type WeekState = 'not_started' | 'in_week' | 'between' | 'ended'

export interface CurrentWeek {
  state: WeekState
  /** 1-based teaching week, or null when not_started/ended. */
  weekNumber: number | null
  /** The session date this points at (this week's, or the next upcoming). */
  date: Date | null
  /** Total teaching weeks in the term (holidays excluded). */
  totalWeeks: number
}

/**
 * Derive the current teaching week for a class from its sessions + `now`.
 * This is how the CRM "knows what week it is on". Pure — pass `now`.
 */
export function currentWeekInfo(
  sessions: WebinarSession[],
  now: Date,
  timeZone: string,
): CurrentWeek {
  const totalWeeks = sessions.length
  if (totalWeeks === 0) {
    return { state: 'not_started', weekNumber: null, date: null, totalWeeks }
  }
  const thisWeek = sessionForLocalWeek(sessions, now, timeZone)
  if (thisWeek) {
    return { state: 'in_week', weekNumber: thisWeek.weekNumber, date: thisWeek.date, totalWeeks }
  }
  const { monday } = localWeekRange(now, timeZone)
  const firstDate = sessions[0]!.date
  const lastDate = sessions[totalWeeks - 1]!.date
  if (monday.getTime() < firstDate.getTime()) {
    return { state: 'not_started', weekNumber: null, date: firstDate, totalWeeks }
  }
  if (monday.getTime() > lastDate.getTime()) {
    return { state: 'ended', weekNumber: null, date: null, totalWeeks }
  }
  const next = sessions.find((s) => s.date.getTime() >= monday.getTime()) ?? null
  return {
    state: 'between',
    weekNumber: next?.weekNumber ?? null,
    date: next?.date ?? null,
    totalWeeks,
  }
}

/**
 * Whether a class's Zoom link is due for rotation: never set, or older than
 * `rotateEveryWeeks`.
 */
export function zoomRotationDue(
  zoomLinkUpdatedAt: Date | null | undefined,
  rotateEveryWeeks: number,
  now: Date,
): boolean {
  if (rotateEveryWeeks <= 0) return false
  if (!zoomLinkUpdatedAt) return true
  const dueMs = zoomLinkUpdatedAt.getTime() + rotateEveryWeeks * 7 * DAY_MS
  return now.getTime() >= dueMs
}
