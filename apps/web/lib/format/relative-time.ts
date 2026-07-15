// Relative time formatter shared across timeline, activity feeds, and lists.
// Stable on the server (RSC) — no `Date.now()` capture in module scope; takes
// `now` from the caller so server-rendered output is deterministic per
// request and matches client hydration.

const SECOND = 1
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

export function formatRelativeTime(at: Date, now: Date = new Date()): string {
  let diffSeconds = Math.round((now.getTime() - at.getTime()) / 1000)
  // Activity timestamps can arrive skewed slightly into the future (a
  // provider reporting wall-clock time in its own timezone). "in 2h" on a
  // message that already happened reads as a glitch — clamp NEAR-future
  // times to "just now". Genuinely future dates (a due date tomorrow) are
  // beyond any timezone skew and still format as "in Xd".
  if (diffSeconds < 0 && diffSeconds > -26 * HOUR) diffSeconds = 0
  const past = diffSeconds >= 0
  const abs = Math.abs(diffSeconds)
  if (abs < 45) return past ? 'just now' : 'in a moment'
  if (abs < MINUTE * 90) {
    const m = Math.round(abs / MINUTE)
    return past ? `${m}m ago` : `in ${m}m`
  }
  if (abs < HOUR * 22) {
    const h = Math.round(abs / HOUR)
    return past ? `${h}h ago` : `in ${h}h`
  }
  if (abs < DAY * 6) {
    const d = Math.round(abs / DAY)
    return past ? `${d}d ago` : `in ${d}d`
  }
  if (abs < WEEK * 4) {
    const w = Math.round(abs / WEEK)
    return past ? `${w}w ago` : `in ${w}w`
  }
  if (abs < YEAR) {
    const m = Math.round(abs / MONTH)
    return past ? `${m}mo ago` : `in ${m}mo`
  }
  const y = Math.round(abs / YEAR)
  return past ? `${y}y ago` : `in ${y}y`
}

export function dueAtLabel(due: Date, now: Date = new Date()): {
  label: string
  tone: 'overdue' | 'today' | 'soon' | 'later'
} {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const startOfDue = new Date(due)
  startOfDue.setHours(0, 0, 0, 0)
  const diffDays = Math.round(
    (startOfDue.getTime() - startOfToday.getTime()) / (24 * 60 * 60 * 1000),
  )
  if (diffDays < 0) {
    const n = Math.abs(diffDays)
    return { label: n === 1 ? 'Overdue 1 day' : `Overdue ${n} days`, tone: 'overdue' }
  }
  if (diffDays === 0) return { label: 'Today', tone: 'today' }
  if (diffDays === 1) return { label: 'Tomorrow', tone: 'soon' }
  if (diffDays < 7) return { label: `In ${diffDays} days`, tone: 'soon' }
  return { label: `In ${diffDays} days`, tone: 'later' }
}
