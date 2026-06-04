// Locale-aware formatting for webinar sessions. UK English, the class timezone
// (CLAUDE.md §29). Pure — given an instant + tz, returns display strings.

const LOCALE = 'en-GB'

/** "Tuesday 9 September 2026" */
export function formatSessionDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant)
}

/** "Tue 9 Sep 2026" — compact form for the PDF table. */
export function formatSessionDateShort(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(instant)
}

/** "18:00 BST" — 24h time with the timezone abbreviation. */
export function formatSessionTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(instant)
}

/** "18:00" from minutes-of-day, for editor displays (no tz). */
export function formatMinuteOfDay(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Parse "18:00" → 1080. Returns null on malformed input. */
export function parseMinuteOfDay(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}
