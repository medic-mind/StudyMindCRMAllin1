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
// Subscription state. Mirrors the Prisma `GcSubscriptionState` enum (ADR 0038).
// -----------------------------------------------------------------------------

export type SubscriptionStatus =
  | 'pending_customer_approval'
  | 'customer_approval_denied'
  | 'active'
  | 'finished'
  | 'cancelled'
  | 'paused'
  | 'unknown'

const KNOWN_SUBSCRIPTION_STATUSES = new Set<string>([
  'pending_customer_approval',
  'customer_approval_denied',
  'active',
  'finished',
  'cancelled',
  'paused',
])

/**
 * Map a GoCardless subscription status string to our domain enum.
 * Unknown values fail closed to `unknown` rather than guess. CLAUDE.md §8.
 */
export function mapSubscriptionStatus(raw: string | null | undefined): SubscriptionStatus {
  if (!raw) return 'unknown'
  return KNOWN_SUBSCRIPTION_STATUSES.has(raw) ? (raw as SubscriptionStatus) : 'unknown'
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
  reference?: string | null
  scheme?: string | null
  next_possible_charge_date?: string | null
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
  description?: string | null
  metadata?: Record<string, string>
  links: {
    mandate?: string
    customer?: string
    subscription?: string
    payout?: string
  }
}

/**
 * Payout statuses are normalised text in the mirror (§15 precedent) — the
 * documented set is pending | paid | bounced; anything new is stored as-is.
 */
export interface GcPayoutResource {
  id: string
  status: string
  amount: number
  currency: string
  created_at: string
  arrival_date?: string | null
  reference?: string | null
  deducted_fees?: number | null
  payout_type?: string | null
  links?: {
    creditor?: string
    creditor_bank_account?: string
  }
}

export interface GcCustomerResource {
  id: string
  created_at: string
  email?: string | null
  given_name?: string | null
  family_name?: string | null
  company_name?: string | null
  /** E.164-ish phone the customer gave GoCardless; used for CRM contact matching. */
  phone_number?: string | null
  metadata?: Record<string, string>
}

export interface GcSubscriptionResource {
  id: string
  created_at: string
  status: string
  name?: string | null
  amount: number
  currency: string
  interval_unit: string
  interval?: number
  day_of_month?: number | null
  month?: string | null
  /** Total number of payments for a fixed-length plan; absent when open-ended. */
  count?: number | null
  start_date?: string | null
  end_date?: string | null
  upcoming_payments?: Array<{ charge_date: string; amount: number }>
  metadata?: Record<string, string>
  links: {
    mandate?: string
  }
}

export interface GcRefundResource {
  id: string
  created_at: string
  amount: number
  currency: string
  reference?: string | null
  status?: string
  metadata?: Record<string, string>
  links: { payment?: string; mandate?: string }
}

export interface GcRedirectFlowResource {
  id: string
  redirect_url: string
  links: {
    mandate?: string
    customer?: string
  }
}

/**
 * GoCardless list responses carry keyset cursors in `meta.cursors`.
 * `after` is null/absent on the last page.
 */
export interface GcListMeta {
  cursors?: { before?: string | null; after?: string | null }
  limit?: number
}
