// Structured complaint-call parser (ADR 0042 amendment). The team logs
// complaint calls in #complaintcallsummaries using a consistent labelled
// format:
//
//   Client Name and Number: Vyshale Arulalagan - UCAT (+1 (647) 901-2817)
//   Guardian Name and Number: Mekala Ganeshamoorthy (+16479618338)
//   Client Email: vyvarul@gmail.com
//   Hours Booked: 30h each
//   Hours Remaining: 27h
//   Amount Paid: £1082
//   Complaint:
//   • Parent is unhappy about …
//   • …
//   Suggested Solution: Offer 1h free as an apology
//   Actions: Find a 2nd tutor …
//
// The old import took the FIRST LINE as the complaint title ("Client Name and
// Number: …") and dumped the whole blob as the description — which read as
// nonsense in the Complaints queue. This parses the labelled fields so the CRM
// can (a) match the customer on the CLIENT email/phone/name and (b) store a
// clean title + a structured description. Pure + dependency-light so it is
// unit-tested without a DB. When the text is NOT the labelled format, the parser
// returns null and the caller falls back to the plain-text draft.

/** One parsed complaint-call summary. Any field may be null if not present. */
export interface StructuredComplaint {
  clientName: string | null
  clientEmail: string | null
  clientPhone: string | null
  guardianName: string | null
  guardianPhone: string | null
  hoursBooked: string | null
  hoursRemaining: string | null
  amountPaid: string | null
  /** The complaint narrative (the bullet list), reflowed to plain lines. */
  complaint: string | null
  suggestedSolution: string | null
  actions: string | null
}

type Field =
  | 'clientContact'
  | 'guardianContact'
  | 'clientEmail'
  | 'hoursBooked'
  | 'hoursRemaining'
  | 'amountPaid'
  | 'complaint'
  | 'suggestedSolution'
  | 'actions'

/** Label synonyms → the field they open. Matched case-insensitively against a
 *  line that starts with `<label>:` (optionally bold `*…*` or bullet-prefixed). */
const LABELS: ReadonlyArray<{ re: RegExp; field: Field }> = [
  { re: /client\s*name\s*(?:and|&|\/)?\s*(?:number|phone|no\.?|tel)?/u, field: 'clientContact' },
  { re: /(?:guardian|parent)\s*name\s*(?:and|&|\/)?\s*(?:number|phone|no\.?|tel)?/u, field: 'guardianContact' },
  { re: /(?:guardian|parent)\s*(?:name|number|phone|contact)?/u, field: 'guardianContact' },
  { re: /client\s*e-?mail/u, field: 'clientEmail' },
  { re: /e-?mail\s*(?:address)?/u, field: 'clientEmail' },
  { re: /hours?\s*booked/u, field: 'hoursBooked' },
  { re: /hours?\s*remaining/u, field: 'hoursRemaining' },
  { re: /amount\s*paid/u, field: 'amountPaid' },
  { re: /complaints?/u, field: 'complaint' },
  { re: /suggested\s*solutions?/u, field: 'suggestedSolution' },
  { re: /solutions?/u, field: 'suggestedSolution' },
  { re: /actions?\s*(?:required|to\s*take)?/u, field: 'actions' },
  { re: /next\s*steps?/u, field: 'actions' },
]

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u
// A phone-shaped run: optional +, then 7+ digits allowing spaces/()-. Broad on
// purpose — the matcher's phoneVariants normalises whatever we hand it.
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/u

/** Strip a leading bullet + surrounding bold/space so we can read the label. */
function delabel(line: string): { label: string; rest: string } | null {
  // "• *Client Name and Number:* Vyshale …" → label="Client Name and Number", rest="Vyshale …"
  const m = /^\s*(?:[-*•●·]\s*)?\*{0,2}\s*([A-Za-z][A-Za-z /&.'-]{1,48}?)\s*\*{0,2}\s*:\s*(.*)$/u.exec(line)
  if (!m) return null
  // Strip a leading bold-close marker ("*Complaint:* it broke" → "it broke").
  const rest = m[2]!.replace(/^\s*\*{1,2}\s*/u, '')
  return { label: m[1]!.trim(), rest }
}

function matchLabel(label: string): Field | null {
  const l = label.toLowerCase().trim()
  for (const { re, field } of LABELS) {
    const anchored = new RegExp(`^(?:${re.source})$`, 'u')
    if (anchored.test(l)) return field
  }
  return null
}

function firstEmail(text: string): string | null {
  const m = EMAIL_RE.exec(text)
  return m ? m[0].toLowerCase() : null
}

function firstPhone(text: string): string | null {
  const m = PHONE_RE.exec(text)
  if (!m) return null
  const raw = m[0].trim()
  // Reject a bare short run that is really "30h"/"27h"/"£1082"-style figures:
  // require at least 7 digits total.
  const digits = raw.replace(/\D/gu, '')
  return digits.length >= 7 ? raw : null
}

/** Pull the human name out of a "Name … (phone)" contact value: drop the phone,
 *  any email, parentheticals, and a trailing " - Course" tag. */
function nameFromContact(value: string): string | null {
  let s = value
  const email = firstEmail(s)
  if (email) s = s.replace(email, ' ')
  const phone = firstPhone(s)
  if (phone) s = s.replace(phone, ' ')
  s = s
    .replace(/\([^)]*\)/gu, ' ') // drop any parenthetical (usually the phone)
    .replace(/[-–—][^-–—]*$/u, ' ') // drop a trailing " - UCAT"/" – course" tag
    .replace(/[|,;]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
  return s.length > 0 ? s.slice(0, 120) : null
}

function clean(value: string | undefined): string | null {
  const t = (value ?? '').trim()
  return t.length > 0 ? t : null
}

/**
 * Parse a labelled complaint-call summary. Returns null when the text does not
 * look like the labelled format (fewer than two recognised labels, or no
 * Complaint section) so the caller can fall back to the plain-text draft.
 */
export function parseStructuredComplaint(plainText: string): StructuredComplaint | null {
  const lines = plainText.split(/\r?\n/u)
  const buckets: Partial<Record<Field, string[]>> = {}
  let current: Field | null = null
  let labelCount = 0

  for (const rawLine of lines) {
    const del = delabel(rawLine)
    const field = del ? matchLabel(del.label) : null
    if (field) {
      labelCount += 1
      current = field
      buckets[field] = buckets[field] ?? []
      if (del!.rest.trim().length > 0) buckets[field]!.push(del!.rest.trim())
    } else if (current) {
      // Continuation of the current field (e.g. a Complaint bullet line).
      const stripped = rawLine.replace(/^\s*[-*•●·]\s*/u, '').trim()
      if (stripped.length > 0) buckets[current]!.push(stripped)
    }
  }

  // Not the labelled format — let the caller use the plain-text fallback.
  if (labelCount < 2 || !buckets['complaint']) return null

  const join = (f: Field): string | null => {
    const parts = buckets[f]
    if (!parts || parts.length === 0) return null
    return parts.join('\n').trim() || null
  }

  const clientContact = join('clientContact')
  const guardianContact = join('guardianContact')
  const emailField = join('clientEmail')

  return {
    clientName: clientContact ? nameFromContact(clientContact) : null,
    clientEmail: (emailField ? firstEmail(emailField) : null) ?? (clientContact ? firstEmail(clientContact) : null),
    clientPhone: clientContact ? firstPhone(clientContact) : null,
    guardianName: guardianContact ? nameFromContact(guardianContact) : null,
    guardianPhone: guardianContact ? firstPhone(guardianContact) : null,
    hoursBooked: clean(join('hoursBooked') ?? undefined),
    hoursRemaining: clean(join('hoursRemaining') ?? undefined),
    amountPaid: clean(join('amountPaid') ?? undefined),
    complaint: join('complaint'),
    suggestedSolution: join('suggestedSolution'),
    actions: join('actions'),
  }
}

/**
 * Extract the CLIENT identity from the team's labelled call-log format — the
 * SAME "Client Name and Number / Client Email / Guardian …" labels a call
 * summary uses — WITHOUT requiring the complaint-specific fields (that's the
 * only difference from parseStructuredComplaint). Used to smart-assign a Slack
 * call summary to the right customer on its authoritative client details.
 * Returns null when the message isn't the labelled format or names no client.
 */
export function parseCallLogClient(plainText: string): {
  clientName: string | null
  clientEmail: string | null
  clientPhone: string | null
} | null {
  const lines = plainText.split(/\r?\n/u)
  const buckets: Partial<Record<Field, string[]>> = {}
  let current: Field | null = null
  let labelCount = 0
  for (const rawLine of lines) {
    const del = delabel(rawLine)
    const field = del ? matchLabel(del.label) : null
    if (field) {
      labelCount += 1
      current = field
      buckets[field] = buckets[field] ?? []
      if (del!.rest.trim().length > 0) buckets[field]!.push(del!.rest.trim())
    } else if (current) {
      const stripped = rawLine.replace(/^\s*[-*•●·]\s*/u, '').trim()
      if (stripped.length > 0) buckets[current]!.push(stripped)
    }
  }
  if (labelCount < 2) return null
  const join = (f: Field): string | null => {
    const parts = buckets[f]
    if (!parts || parts.length === 0) return null
    return parts.join('\n').trim() || null
  }
  const clientContact = join('clientContact')
  const emailField = join('clientEmail')
  const clientName = clientContact ? nameFromContact(clientContact) : null
  const clientEmail =
    (emailField ? firstEmail(emailField) : null) ??
    (clientContact ? firstEmail(clientContact) : null)
  const clientPhone = clientContact ? firstPhone(clientContact) : null
  if (!clientName && !clientEmail && !clientPhone) return null
  return { clientName, clientEmail, clientPhone }
}

/** A clean, human-readable title for the complaint. */
export function structuredComplaintTitle(s: StructuredComplaint): string {
  if (s.clientName) return `Complaint — ${s.clientName}`.slice(0, 200)
  const firstBullet = (s.complaint ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return (firstBullet || 'Complaint call summary (Slack)').slice(0, 200)
}

/** A structured, readable description: the narrative first, then the suggested
 *  solution + actions, then the customer/context details. */
export function structuredComplaintDescription(s: StructuredComplaint): string {
  const sections: string[] = []
  if (s.complaint) sections.push(s.complaint.trim())
  if (s.suggestedSolution) sections.push(`Suggested solution: ${s.suggestedSolution.trim()}`)
  if (s.actions) sections.push(`Actions: ${s.actions.trim()}`)

  const details: string[] = []
  const clientLine = [s.clientName, s.clientEmail, s.clientPhone].filter(Boolean).join(' · ')
  if (clientLine) details.push(`Client: ${clientLine}`)
  const guardianLine = [s.guardianName, s.guardianPhone].filter(Boolean).join(' · ')
  if (guardianLine) details.push(`Guardian: ${guardianLine}`)
  const hoursLine = [
    s.hoursBooked ? `Hours booked: ${s.hoursBooked}` : null,
    s.hoursRemaining ? `Hours remaining: ${s.hoursRemaining}` : null,
    s.amountPaid ? `Amount paid: ${s.amountPaid}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  if (hoursLine) details.push(hoursLine)
  if (details.length > 0) sections.push(details.join('\n'))

  return sections.join('\n\n').slice(0, 4000)
}
