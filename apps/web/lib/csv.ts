// Tiny CSV export helper. Used by the export buttons on every list page.
// Quotes fields that contain commas, quotes, or newlines (RFC 4180); other
// fields ship as-is so the resulting file imports cleanly into Excel /
// Numbers / Google Sheets / pandas / etc.
//
// `downloadCsv` builds a Blob and clicks an invisible <a> — works in every
// browser we target, no native file-picker dialog required, and the file
// name carries the picked timestamp so re-exports don't clobber each other.

export type CsvCell = string | number | boolean | Date | null | undefined

export interface CsvColumn<T> {
  header: string
  value: (row: T) => CsvCell
}

function escapeField(v: CsvCell): string {
  if (v === null || v === undefined) return ''
  let s: string
  if (v instanceof Date) {
    s = v.toISOString()
  } else if (typeof v === 'boolean') {
    s = v ? 'true' : 'false'
  } else if (typeof v === 'number') {
    s = Number.isFinite(v) ? String(v) : ''
  } else {
    s = v
  }
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** UTF-8 BOM so Excel auto-detects the encoding. */
const UTF8_BOM = String.fromCharCode(0xfeff)

export function rowsToCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const header = columns.map((c) => escapeField(c.header)).join(',')
  const body = rows
    .map((row) => columns.map((c) => escapeField(c.value(row))).join(','))
    .join('\r\n')
  return `${UTF8_BOM}${header}\r\n${body}`
}

function timestampSuffix(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}`
  )
}

export function downloadCsv<T>(
  fileNameBase: string,
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
): void {
  if (typeof window === 'undefined') return
  const text = rowsToCsv(rows, columns)
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${fileNameBase}_${timestampSuffix()}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Give Safari a beat before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
