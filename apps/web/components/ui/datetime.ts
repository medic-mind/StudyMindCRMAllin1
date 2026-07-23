// Pure date helpers for the <DateTimePicker> (datetime-picker.tsx) — no React,
// no timezone maths (that stays in lib/format/london-time.ts). The picker works
// in the same "wall-clock" string shape a native <input type="datetime-local">
// uses — "YYYY-MM-DDTHH:mm" — so it drops straight into the existing
// londonWallToUtc / utcToLondonWall plumbing (CLAUDE.md §29) with no other
// changes at the call sites.

export interface WallParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number // 0-59
}

/** Parse a "YYYY-MM-DDTHH:mm" wall-clock string. Returns null if malformed. */
export function parseWall(value: string | null | undefined): WallParts | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(value)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  return {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Serialise parts back to the "YYYY-MM-DDTHH:mm" wall-clock string. */
export function formatWall(p: WallParts): string {
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/**
 * Monday-first weeks for a month, each a 7-cell row. Leading/trailing cells the
 * month doesn't own are null so the grid always renders full weeks.
 */
export function buildCalendarWeeks(year: number, month: number): (number | null)[][] {
  // Use UTC arithmetic purely for the calendar layout — no timezone meaning.
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay() // 0=Sun
  const leadingBlanks = (firstDow + 6) % 7 // shift so Monday = 0
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()

  const cells: (number | null)[] = []
  for (let i = 0; i < leadingBlanks; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  const weeks: (number | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

/** Move a {year, month} view by ±1 month, rolling the year over. */
export function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + delta
  return { year: Math.floor(zero / 12), month: (((zero % 12) + 12) % 12) + 1 }
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "July 2026" style heading for the calendar. */
export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`
}

/** Human label for a wall-clock value, e.g. "Thu 2 Jul 2026 · 14:30". */
export function humanWallLabel(value: string | null | undefined): string {
  const p = parseWall(value)
  if (!p) return ''
  // Format the parts directly (in UTC so the numbers we parsed are the numbers
  // shown — no timezone shift, this is a wall-clock label not an instant).
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day))
  const datePart = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
  return `${datePart} · ${pad(p.hour)}:${pad(p.minute)}`
}
