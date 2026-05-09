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
