// Helpers for parsing the from/to URL query parameters across the report
// pages. Defaults to the last 30 days.

export interface ReportPeriod {
  from: Date
  to: Date
  fromIso: string
  toIso: string
}

function parseDate(s: string | undefined, fallback: Date): Date {
  if (!s) return fallback
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return fallback
  return d
}

export function parsePeriod(sp: { from?: string; to?: string }): ReportPeriod {
  const now = new Date()
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const from = parseDate(sp.from, defaultFrom)
  const to = parseDate(sp.to, now)
  return {
    from,
    to,
    fromIso: from.toISOString().slice(0, 10),
    toIso: to.toISOString().slice(0, 10),
  }
}

export function fmtMoney(minor: number): string {
  const pounds = minor / 100
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
  }).format(pounds)
}

export type PeriodPreset =
  | 'last_7'
  | 'last_30'
  | 'last_90'
  | 'this_quarter'
  | 'last_quarter'
  | 'ytd'

export interface PresetRange {
  key: PeriodPreset
  label: string
  fromIso: string
  toIso: string
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function startOfQuarter(d: Date): Date {
  const m = d.getUTCMonth()
  const qStart = Math.floor(m / 3) * 3
  return new Date(Date.UTC(d.getUTCFullYear(), qStart, 1))
}

/** Canonical preset list. Renders the chip row + detects the active chip. */
export function buildPeriodPresets(now: Date = new Date()): PresetRange[] {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const todayIso = isoDay(today)

  const last7 = new Date(today)
  last7.setUTCDate(today.getUTCDate() - 7)
  const last30 = new Date(today)
  last30.setUTCDate(today.getUTCDate() - 30)
  const last90 = new Date(today)
  last90.setUTCDate(today.getUTCDate() - 90)

  const thisQStart = startOfQuarter(today)
  const lastQStart = new Date(thisQStart)
  lastQStart.setUTCMonth(thisQStart.getUTCMonth() - 3)
  const lastQEnd = new Date(thisQStart)
  lastQEnd.setUTCDate(thisQStart.getUTCDate() - 1)

  const ytd = new Date(Date.UTC(today.getUTCFullYear(), 0, 1))

  return [
    { key: 'last_7', label: 'Last 7 days', fromIso: isoDay(last7), toIso: todayIso },
    { key: 'last_30', label: 'Last 30 days', fromIso: isoDay(last30), toIso: todayIso },
    { key: 'last_90', label: 'Last 90 days', fromIso: isoDay(last90), toIso: todayIso },
    {
      key: 'this_quarter',
      label: 'This quarter',
      fromIso: isoDay(thisQStart),
      toIso: todayIso,
    },
    {
      key: 'last_quarter',
      label: 'Last quarter',
      fromIso: isoDay(lastQStart),
      toIso: isoDay(lastQEnd),
    },
    { key: 'ytd', label: 'Year to date', fromIso: isoDay(ytd), toIso: todayIso },
  ]
}
