// Summer Camp instalment tracking (CLAUDE.md §15 sibling — camp.studymind.co.uk).
//
// Pure logic only (no I/O), so it is unit-tested. Powers the instalment tracker
// in the Summer Camp section: import a booking CSV, track each booking's total
// due vs deposit received, and derive the remaining balance.
//
// Money rule (§19): everything is integer minor units (pence). The remaining
// balance is DERIVED (total − deposit), never stored (§41.2).

// -----------------------------------------------------------------------------
// RFC 4180 CSV parsing — the booking sheet has quoted fields containing commas
// AND newlines (multi-line Notes), so a line-by-line split is wrong.
// -----------------------------------------------------------------------------

/** Tokenise CSV text into rows of string cells (handles quotes, "" escapes, and
 *  embedded commas + newlines inside quoted fields). */
export function parseCsvRows(text: string): string[][] {
  const s = text.replace(/\r\n?/gu, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += c
      i += 1
      continue
    }
    if (c === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    field += c
    i += 1
  }
  // Flush the trailing field/row (a file not ending in a newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// -----------------------------------------------------------------------------
// Money + deposit parsing
// -----------------------------------------------------------------------------

/** "£2,999.50" / "2999" / "" → minor units (pence). Returns 0 for blanks. */
export function parseMoneyToMinor(raw: string | null | undefined): number {
  if (!raw) return 0
  const cleaned = raw.replace(/[£$,\s]/gu, '')
  const n = Number.parseFloat(cleaned)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

/** Pull the deposit actually received out of free-text notes — "Paid Initial
 *  £500", "deposit £750", a bare "£500". Returns minor units, or null. */
/**
 * A deposit figure read from the notes, tagged with whether it was LABELLED
 * (named as a deposit/initial/paid figure) or a BARE `£` amount. The caller
 * trusts a labelled figure for any payment type, but only trusts a bare figure
 * for a part-payment booking — otherwise a stray `£` (e.g. "Booking fee £200
 * paid separately") on a SETTLED booking overstates the outstanding balance.
 */
export function parseDepositFromNotes(
  notes: string | null | undefined,
): { value: number; labelled: boolean } | null {
  if (!notes) return null
  const labelled = notes.match(
    /(?:paid\s*initial|initial\s*payment|initial|deposit|paid)\D{0,8}£?\s*([\d,]+(?:\.\d+)?)/iu,
  )
  if (labelled?.[1]) return { value: parseMoneyToMinor(labelled[1]), labelled: true }
  const bare = notes.match(/£\s*([\d,]+(?:\.\d+)?)/u)
  if (bare?.[1]) return { value: parseMoneyToMinor(bare[1]), labelled: false }
  return null
}

/** Standard initial deposit when a partial-payment booking doesn't state one. */
export const DEFAULT_DEPOSIT_MINOR = 50000 // £500

/** True for payment types that are a PART payment (a balance remains): the
 *  "instalment" cohort. A "Bank Deposit" / "Stripe" / blank / "Free" booking is
 *  treated as settled (deposit = total) unless edited. */
export function isPartialPaymentType(paymentType: string | null | undefined): boolean {
  if (!paymentType) return false
  return /instal/iu.test(paymentType) || /initial\s*deposit/iu.test(paymentType)
}

// -----------------------------------------------------------------------------
// Booking record
// -----------------------------------------------------------------------------

export interface ParsedCampBooking {
  dedupeKey: string
  externalRef: string | null
  bookingType: string | null
  paymentType: string | null
  subject: string | null
  studentName: string | null
  studentEmail: string | null
  studentPhone: string | null
  guardianName: string | null
  guardianEmail: string | null
  guardianPhone: string | null
  totalDueMinor: number
  depositPaidMinor: number
  accomFeeMinor: number
  researchProgramMinor: number
  weeks: string | null
  noOfDays: number | null
  status: string | null
  agent: string | null
  dateOfPayment: Date | null
  notes: string | null
}

const norm = (v: string | null | undefined): string =>
  (v ?? '').toLowerCase().replace(/\s+/gu, ' ').trim()

const clean = (v: string | undefined): string | null => {
  const t = (v ?? '').trim()
  return t.length > 0 ? t : null
}

/** Find a column index by trying each candidate against the trimmed,
 *  lower-cased headers (exact first, then "starts with"/"includes"). */
function colIndex(headers: string[], candidates: string[]): number {
  const h = headers.map((x) => x.toLowerCase().trim())
  for (const cand of candidates) {
    const c = cand.toLowerCase()
    const exact = h.indexOf(c)
    if (exact !== -1) return exact
  }
  for (const cand of candidates) {
    const c = cand.toLowerCase()
    const idx = h.findIndex((x) => x.startsWith(c) || x.includes(c))
    if (idx !== -1) return idx
  }
  return -1
}

function parseUsDate(raw: string | null): Date | null {
  if (!raw) return null
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/u)
  if (!m) return null
  const month = Number(m[1])
  const day = Number(m[2])
  let year = Number(m[3])
  if (year < 100) year += 2000
  const d = new Date(Date.UTC(year, month - 1, day))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Parse a Summer Camp booking CSV into normalised booking records, computing the
 * deposit received (from Notes, else the standard £500 for a partial booking,
 * else the full total for a settled one). Skips header + empty rows. Each record
 * gets a stable `dedupeKey` so re-importing the latest sheet updates rather than
 * duplicates.
 */
export function parseInstalmentCsv(text: string): ParsedCampBooking[] {
  const rows = parseCsvRows(text)
  if (rows.length < 2) return []
  const headers = rows[0]!
  const idx = {
    int: colIndex(headers, ['int']),
    type: colIndex(headers, ['type']),
    dateOfPayment: colIndex(headers, ['date of payment']),
    subject: colIndex(headers, ['subject']),
    studentName: colIndex(headers, ['name of student', 'student name']),
    studentEmail: colIndex(headers, ['email address']),
    studentPhone: colIndex(headers, ['mobile number']),
    guardianName: colIndex(headers, ['guardian name']),
    guardianEmail: colIndex(headers, ['g-email address', 'guardian email']),
    guardianPhone: colIndex(headers, ['g-mobile number', 'guardian mobile']),
    paymentType: colIndex(headers, ['payment type']),
    amount: colIndex(headers, ['amount paid']),
    accom: colIndex(headers, ['accom fee']),
    days: colIndex(headers, ['no of days booked', 'no of days']),
    weeks: colIndex(headers, ['week']),
    status: colIndex(headers, ['status']),
    agent: colIndex(headers, ['agent']),
    notes: colIndex(headers, ['notes']),
    research: colIndex(headers, ['research program', 'online research']),
  }
  const at = (row: string[], i: number): string | undefined => (i >= 0 ? row[i] : undefined)

  const out: ParsedCampBooking[] = []
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]!
    const studentName = clean(at(row, idx.studentName))
    const studentEmail = clean(at(row, idx.studentEmail))?.toLowerCase() ?? null
    const totalDueMinor = parseMoneyToMinor(at(row, idx.amount))
    // Skip blank/separator rows (no identity AND no money).
    if (!studentName && !studentEmail && totalDueMinor === 0) continue

    const paymentType = clean(at(row, idx.paymentType))
    const notes = clean(at(row, idx.notes))
    const subject = clean(at(row, idx.subject))
    const weeks = clean(at(row, idx.weeks))

    const fromNotes = parseDepositFromNotes(notes)
    const partial = isPartialPaymentType(paymentType)
    // A labelled notes deposit is trusted for any payment type; a BARE `£`
    // figure only counts as the deposit for a part-payment booking (otherwise a
    // stray amount overstates the outstanding on a settled booking). Settled
    // bookings with no trusted deposit are paid in full (deposit = total).
    const depositPaidMinor =
      fromNotes != null && (fromNotes.labelled || partial)
        ? fromNotes.value
        : partial
          ? DEFAULT_DEPOSIT_MINOR
          : totalDueMinor

    const daysRaw = clean(at(row, idx.days))
    const noOfDays = daysRaw && /^\d+$/u.test(daysRaw) ? Number(daysRaw) : null

    out.push({
      dedupeKey: [norm(studentEmail ?? studentName), norm(subject), norm(weeks)].join('|'),
      externalRef: clean(at(row, idx.int)),
      bookingType: clean(at(row, idx.type)),
      paymentType,
      subject,
      studentName,
      studentEmail,
      studentPhone: clean(at(row, idx.studentPhone)),
      guardianName: clean(at(row, idx.guardianName)),
      guardianEmail: clean(at(row, idx.guardianEmail))?.toLowerCase() ?? null,
      guardianPhone: clean(at(row, idx.guardianPhone)),
      totalDueMinor,
      depositPaidMinor: Math.min(depositPaidMinor, totalDueMinor || depositPaidMinor),
      accomFeeMinor: parseMoneyToMinor(at(row, idx.accom)),
      researchProgramMinor: parseMoneyToMinor(at(row, idx.research)),
      weeks,
      noOfDays,
      status: clean(at(row, idx.status)),
      agent: clean(at(row, idx.agent)),
      dateOfPayment: parseUsDate(clean(at(row, idx.dateOfPayment))),
      notes,
    })
  }
  return out
}

// -----------------------------------------------------------------------------
// Derivations used by the list view (remaining is never stored — §41.2)
// -----------------------------------------------------------------------------

export interface InstalmentFigures {
  totalDueMinor: number
  depositPaidMinor: number
  remainingMinor: number
}

export type InstalmentState = 'paid' | 'deposit_paid' | 'unpaid'

export function remainingMinor(totalDueMinor: number, depositPaidMinor: number): number {
  return Math.max(0, totalDueMinor - depositPaidMinor)
}

export function instalmentState(totalDueMinor: number, depositPaidMinor: number): InstalmentState {
  if (remainingMinor(totalDueMinor, depositPaidMinor) <= 0) return 'paid'
  return depositPaidMinor > 0 ? 'deposit_paid' : 'unpaid'
}

/** A booking is "on instalments" when a balance remains, or its payment type is
 *  a part-payment type — the cohort the user wants to filter to. */
export function isOnInstalments(b: {
  paymentType: string | null
  totalDueMinor: number
  depositPaidMinor: number
}): boolean {
  return (
    isPartialPaymentType(b.paymentType) || remainingMinor(b.totalDueMinor, b.depositPaidMinor) > 0
  )
}

export interface InstalmentSummary {
  count: number
  onInstalments: number
  totalDueMinor: number
  totalDepositMinor: number
  totalOutstandingMinor: number
}

export function summariseInstalments(
  rows: ReadonlyArray<{
    paymentType: string | null
    totalDueMinor: number
    depositPaidMinor: number
  }>,
): InstalmentSummary {
  let totalDueMinor = 0
  let totalDepositMinor = 0
  let totalOutstandingMinor = 0
  let onInstalments = 0
  for (const r of rows) {
    totalDueMinor += r.totalDueMinor
    totalDepositMinor += r.depositPaidMinor
    totalOutstandingMinor += remainingMinor(r.totalDueMinor, r.depositPaidMinor)
    if (isOnInstalments(r)) onInstalments += 1
  }
  return {
    count: rows.length,
    onInstalments,
    totalDueMinor,
    totalDepositMinor,
    totalOutstandingMinor,
  }
}
