// Domain-mapped types for the B2B Invoices Platform (b2b.studymind.co.uk).
//
// Field names are VERBATIM from the platform API contract — do NOT rename
// them. Raw API shapes (snake_case where the API uses it) stay inside this
// package; the rest of the CRM reads the normalised Prisma mirror rows.
//
// Two conventions matter here:
//   - Money. The API speaks decimal strings/numbers ("720.00"). We convert to
//     integer minor units (pence) on the way in and back to a number on the
//     way out — never float maths on money (CLAUDE.md §19).
//   - Fail closed. Unknown enum values map to `unknown` rather than guess
//     (CLAUDE.md §8). New platform statuses are added here explicitly.

import { z } from 'zod'

// -----------------------------------------------------------------------------
// Enums (mirror the Prisma enums; the platform is the source of the values).
// -----------------------------------------------------------------------------

export type InvoicingCustomerCategory = 'b2b' | 'b2c' | 'alt_provision' | 'unknown'
export type InvoicingCustomerStatus = 'active' | 'on_hold' | 'archived' | 'unknown'
export type InvoicingInvoiceStatus =
  | 'draft'
  | 'issued'
  | 'partially_paid'
  | 'paid'
  | 'overdue'
  | 'cancelled'
  | 'unknown'
export type InvoicingClientType =
  | 'uk_b2b'
  | 'school'
  | 'summer_school'
  | 'international'
  | 'unknown'

const KNOWN_CATEGORIES = new Set<string>(['b2b', 'b2c', 'alt_provision'])
const KNOWN_CUSTOMER_STATUSES = new Set<string>(['active', 'on_hold', 'archived'])
const KNOWN_INVOICE_STATUSES = new Set<string>([
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'overdue',
  'cancelled',
])
const KNOWN_CLIENT_TYPES = new Set<string>(['uk_b2b', 'school', 'summer_school', 'international'])

export function mapCustomerCategory(value: string | null | undefined): InvoicingCustomerCategory {
  if (!value) return 'unknown'
  return KNOWN_CATEGORIES.has(value) ? (value as InvoicingCustomerCategory) : 'unknown'
}

export function mapCustomerStatus(value: string | null | undefined): InvoicingCustomerStatus {
  if (!value) return 'unknown'
  return KNOWN_CUSTOMER_STATUSES.has(value) ? (value as InvoicingCustomerStatus) : 'unknown'
}

export function mapInvoiceStatus(value: string | null | undefined): InvoicingInvoiceStatus {
  if (!value) return 'unknown'
  return KNOWN_INVOICE_STATUSES.has(value) ? (value as InvoicingInvoiceStatus) : 'unknown'
}

export function mapClientType(value: string | null | undefined): InvoicingClientType {
  if (!value) return 'unknown'
  return KNOWN_CLIENT_TYPES.has(value) ? (value as InvoicingClientType) : 'unknown'
}

// -----------------------------------------------------------------------------
// Money helpers. The API returns either a decimal string ("720.00") or a
// number; both convert to integer pence without float drift.
// -----------------------------------------------------------------------------

/**
 * Convert a money value (decimal string, number, or null) to integer minor
 * units (pence). Parses the integer and fractional parts separately so we
 * never run `Number * 100` on a float (CLAUDE.md §19, never floats for money).
 */
export function toMinor(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  const str = typeof value === 'number' ? value.toFixed(2) : value.trim()
  const negative = str.startsWith('-')
  const unsigned = negative ? str.slice(1) : str
  const [whole = '0', fracRaw = ''] = unsigned.split('.')
  const frac = `${fracRaw}00`.slice(0, 2)
  const wholeInt = Number.parseInt(whole.replace(/[^0-9]/g, '') || '0', 10)
  const fracInt = Number.parseInt(frac.replace(/[^0-9]/g, '') || '0', 10)
  const minor = wholeInt * 100 + fracInt
  return negative ? -minor : minor
}

/** Convert integer minor units back to a major-unit number for the API. */
export function toMajor(minor: number): number {
  return Math.round(minor) / 100
}

// -----------------------------------------------------------------------------
// Raw API response shapes (Zod-validated at the boundary). Permissive — the
// platform may add fields; we ignore unknown ones.
// -----------------------------------------------------------------------------

export const RawCustomer = z
  .object({
    id: z.string(),
    company_name: z.string(),
    contact_name: z.string().nullish(),
    contact_email: z.string().nullish(),
    contact_email_cc: z.string().nullish(),
    phone: z.string().nullish(),
    address: z.string().nullish(),
    country: z.string().nullish(),
    vat_number: z.string().nullish(),
    status: z.string().nullish(),
    category: z.string().nullish(),
    service: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
    notes: z.string().nullish(),
  })
  .passthrough()
export type RawCustomer = z.infer<typeof RawCustomer>

export const RawLineItem = z
  .object({
    id: z.union([z.string(), z.number()]).nullish(),
    description: z.string(),
    quantity: z.union([z.string(), z.number()]),
    unit_price: z.union([z.string(), z.number()]),
    vat_rate: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough()
export type RawLineItem = z.infer<typeof RawLineItem>

export const RawPayment = z
  .object({
    id: z.union([z.string(), z.number()]),
    amount: z.union([z.string(), z.number()]),
    currency: z.string().nullish(),
    method: z.string().nullish(),
    reference: z.string().nullish(),
    created_at: z.string().nullish(),
    paid_at: z.string().nullish(),
  })
  .passthrough()
export type RawPayment = z.infer<typeof RawPayment>

export const RawInvoice = z
  .object({
    id: z.string(),
    invoice_number: z.string().nullish(),
    partner_id: z.string().nullish(),
    status: z.string().nullish(),
    client_type: z.string().nullish(),
    currency: z.string().nullish(),
    issue_date: z.string().nullish(),
    due_date: z.string().nullish(),
    payment_terms: z.string().nullish(),
    notes: z.string().nullish(),
    internal_notes: z.string().nullish(),
    bill_to_name: z.string().nullish(),
    from_email: z.string().nullish(),
    payment_reference: z.string().nullish(),
    po_number: z.string().nullish(),
    prices_include_vat: z.boolean().nullish(),
    subtotal: z.union([z.string(), z.number()]).nullish(),
    vat_total: z.union([z.string(), z.number()]).nullish(),
    grand_total: z.union([z.string(), z.number()]).nullish(),
    last_emailed_at: z.string().nullish(),
    line_items: z.array(RawLineItem).nullish(),
    payments: z.array(RawPayment).nullish(),
  })
  .passthrough()
export type RawInvoice = z.infer<typeof RawInvoice>

/** Standard list envelope returned by every list endpoint. */
export interface ListResponse<T> {
  data: T[]
  page: number
  page_size: number
  total: number
}

/** A single event from the pull-feed / SSE / webhook (same shape). */
export const RawEvent = z
  .object({
    id: z.string(),
    cursor: z.union([z.string(), z.number()]).nullish(),
    type: z.string(),
    source: z.string().nullish(),
    created_at: z.string().nullish(),
    entity_type: z.string().nullish(),
    action: z.string().nullish(),
    record: z.unknown().nullish(),
  })
  .passthrough()
export type RawEvent = z.infer<typeof RawEvent>

export const EventsFeedResponse = z.object({
  data: z.array(RawEvent),
  next_cursor: z.string().nullish(),
  has_more: z.boolean().nullish(),
})
export type EventsFeedResponse = z.infer<typeof EventsFeedResponse>

/** The `source` of every event. "api" = our own writes (skip on inbound). */
export type EventSource = 'api' | 'app' | 'system' | 'unknown'

export function mapEventSource(value: string | null | undefined): EventSource {
  if (value === 'api' || value === 'app' || value === 'system') return value
  return 'unknown'
}

/** Entity types the webhook/feed emits. */
export type InvoicingEntityType =
  | 'partner'
  | 'invoice'
  | 'invoice_line_item'
  | 'payment'
  | 'task'
  | 'student'
  | 'unknown'

export function mapEntityType(value: string | null | undefined): InvoicingEntityType {
  switch (value) {
    case 'partner':
    case 'invoice':
    case 'invoice_line_item':
    case 'payment':
    case 'task':
    case 'student':
      return value
    default:
      return 'unknown'
  }
}
