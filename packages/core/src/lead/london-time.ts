// Europe/London wall-clock → UTC, dependency-free (CLAUDE.md §29: store UTC,
// pick in London time). Mirrors apps/web/lib/format/london-time but lives in
// core so the lead job (packages/jobs) can use it without importing apps/web.
// A "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD" string the enquirer picked is read as
// London local time; a bare date defaults to 09:00 (a sensible call slot).

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
 * Convert a London wall-clock "YYYY-MM-DDTHH:mm" (or bare "YYYY-MM-DD",
 * defaulting to 09:00) to the matching UTC instant. Returns null for empty /
 * malformed input. Resolves the DST edge by re-checking the offset.
 */
export function londonWallToUtc(wall: string | null | undefined): Date | null {
  if (!wall) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/u.exec(wall)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = m[4] === undefined ? 9 : Number(m[4])
  const mi = m[5] === undefined ? 0 : Number(m[5])
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const off1 = londonOffsetMinutes(new Date(guess))
  let utc = guess - off1 * 60000
  const off2 = londonOffsetMinutes(new Date(utc))
  if (off2 !== off1) utc = guess - off2 * 60000
  return new Date(utc)
}
