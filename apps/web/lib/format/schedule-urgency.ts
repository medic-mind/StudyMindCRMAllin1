// Todoist-style urgency colouring for a scheduled call time, so an agent can
// see at a glance which calls need doing. Buckets a target time against "now"
// on the Europe/London calendar (scheduled calls are London wall-clock, §29):
//   overdue → red · today → orange · tomorrow → amber · this week → blue ·
//   later → neutral. Pure + unit-tested; consumed by the board card chip.

export type ScheduleUrgency = 'overdue' | 'today' | 'tomorrow' | 'soon' | 'later'

const DAY_MS = 24 * 60 * 60 * 1000

/** The London calendar day of `d` as an ISO `yyyy-mm-dd` key. */
function londonDayKey(d: Date): string {
  // en-CA renders as yyyy-mm-dd; the timeZone pins it to the London day.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

export function scheduleUrgency(target: Date, now: Date): ScheduleUrgency {
  if (target.getTime() < now.getTime()) return 'overdue'
  const t = londonDayKey(target)
  if (t === londonDayKey(now)) return 'today'
  if (t === londonDayKey(new Date(now.getTime() + DAY_MS))) return 'tomorrow'
  if (target.getTime() - now.getTime() < 7 * DAY_MS) return 'soon'
  return 'later'
}

/** Tailwind chip classes per urgency (bg + text + ring), tokens only (§4). */
export const URGENCY_CHIP_CLASS: Record<ScheduleUrgency, string> = {
  overdue: 'bg-red-50 text-red-700 ring-red-100',
  today: 'bg-orange-50 text-orange-700 ring-orange-100',
  tomorrow: 'bg-amber-50 text-amber-800 ring-amber-100',
  soon: 'bg-primary-50 text-primary-700 ring-primary-100',
  later: 'bg-neutral-100 text-neutral-600 ring-neutral-200',
}

/** Short prefix shown before the time ("Overdue · 09:00"), empty for `later`. */
export const URGENCY_LABEL: Record<ScheduleUrgency, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  soon: 'This week',
  later: '',
}
