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
