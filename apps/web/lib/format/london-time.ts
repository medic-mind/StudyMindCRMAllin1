// Europe/London wall-clock ⇄ UTC helpers for the call-scheduling pickers.
// CLAUDE.md §29: time is stored UTC; the UI picks/renders in Europe/London
// regardless of the agent's own machine timezone (so a London "2:30pm call"
// is unambiguous even for an agent working abroad). No tz library — we lean
// on the platform `Intl` time-zone database, which knows GMT/BST and its
// DST transitions.

/** Minutes Europe/London is ahead of UTC at the given instant (+60 in BST). */
function londonOffsetMinutes(utc: Date): number {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(utc)) m[p.type] = p.value
  const wallAsUtc = Date.UTC(
    Number(m.year),
    Number(m.month) - 1,
    Number(m.day),
    Number(m.hour),
    Number(m.minute),
    Number(m.second),
  )
  return (wallAsUtc - utc.getTime()) / 60000
}

/**
 * Convert a `datetime-local` value ("YYYY-MM-DDTHH:mm"), read as Europe/London
 * wall-clock time, into the corresponding UTC instant. Returns null for empty
 * / malformed input. Resolves the DST edge by re-checking the offset.
 */
export function londonWallToUtc(wall: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(wall)
  if (!match) return null
  const [, y, mo, d, h, mi] = match.map(Number) as unknown as number[]
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!)
  const off1 = londonOffsetMinutes(new Date(guess))
  let utc = guess - off1 * 60000
  const off2 = londonOffsetMinutes(new Date(utc))
  if (off2 !== off1) utc = guess - off2 * 60000
  return new Date(utc)
}

/** Render a UTC instant as a `datetime-local` value in Europe/London. */
export function utcToLondonWall(d: Date | string | null | undefined): string {
  if (!d) return ''
  const date = typeof d === 'string' ? new Date(d) : d
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value
  // Intl can emit "24" for midnight on some engines; normalise to "00".
  const hour = m.hour === '24' ? '00' : m.hour
  return `${m.year}-${m.month}-${m.day}T${hour}:${m.minute}`
}

/** Human-readable Europe/London render, e.g. "3 Jun 2026, 14:30". */
export function formatLondon(
  d: Date | string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  if (!d) return ''
  const date = typeof d === 'string' ? new Date(d) : d
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    ...opts,
  }).format(date)
}
