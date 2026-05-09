// Domain-mapped types for GoCardless.
// Raw GoCardless payload shapes stay inside this package; the rest of the app
// reads these typed shapes only. CLAUDE.md §6.4 + §9: fail closed on unknown.

// -----------------------------------------------------------------------------
// Mandate state. Mirrors the Prisma `MandateState` enum (CLAUDE.md §6.4).
// -----------------------------------------------------------------------------

export type MandateStatus =
  | 'pending_submission'
  | 'submitted'
  | 'active'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'replaced'
  | 'unknown'

const KNOWN_MANDATE_STATUSES = new Set<string>([
  'pending_submission',
  'submitted',
  'active',
  'failed',
  'cancelled',
  'expired',
  'replaced',
])

/**
 * Map a GoCardless mandate status string to our domain enum.
 * Unknown values fail closed to `unknown` rather than guess. CLAUDE.md §9.
 */
export function mapMandateStatus(raw: string | null | undefined): MandateStatus {
  if (!raw) return 'unknown'
  return KNOWN_MANDATE_STATUSES.has(raw) ? (raw as MandateStatus) : 'unknown'
}

// -----------------------------------------------------------------------------
// Payment state.
// -----------------------------------------------------------------------------

export type PaymentStatus =
  | 'pending_customer_approval'
  | 'pending_submission'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'charged_back'
  | 'paid_out'
  | 'cancelled'
  | 'unknown'

const KNOWN_PAYMENT_STATUSES = new Set<string>([
  'pending_customer_approval',
  'pending_submission',
  'submitted',
  'confirmed',
  'failed',
  'charged_back',
  'paid_out',
  'cancelled',
])

export function mapPaymentStatus(raw: string | null | undefined): PaymentStatus {
  if (!raw) return 'unknown'
  return KNOWN_PAYMENT_STATUSES.has(raw) ? (raw as PaymentStatus) : 'unknown'
}

// -----------------------------------------------------------------------------
// Webhook payload shapes (CLAUDE.md §9: a single request can carry multiple
// events in `events[]`).
// -----------------------------------------------------------------------------

export interface GcEventLinks {
  mandate?: string
  payment?: string
  customer?: string
  /** Present on `mandates/replaced` events. */
  new_mandate?: string
  previous_customer_bank_account?: string
  [key: string]: string | undefined
}

export interface GcEvent {
  id: string
  created_at: string
  resource_type: 'mandates' | 'payments' | 'subscriptions' | 'customers' | string
  action: string
  links: GcEventLinks
  details?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface GcWebhookPayload {
  events: GcEvent[]
}

/**
 * Compose `<resource_type>/<action>` for routing — mirrors the convention
 * used in CLAUDE.md §9 ("payments/late_failure_settled", "mandates/replaced").
 */
export function gcEventKey(event: GcEvent): string {
  return `${event.resource_type}/${event.action}`
}

// -----------------------------------------------------------------------------
// Refetched canonical resources (subset — only fields we mirror).
// -----------------------------------------------------------------------------

export interface GcMandateResource {
  id: string
  status: string
  created_at: string
  links: {
    customer?: string
    new_mandate?: string
  }
}

export interface GcPaymentResource {
  id: string
  status: string
  amount: number
  currency: string
  created_at: string
  charge_date?: string | null
  links: {
    mandate?: string
    customer?: string
  }
}

export interface GcRedirectFlowResource {
  id: string
  redirect_url: string
  links: {
    mandate?: string
    customer?: string
  }
}
