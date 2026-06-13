// Convert raw GoCardless resources into the core mirror-upsert inputs
// (ADR 0038). Date-only strings (charge_date, start_date) parse to UTC
// midnight, which is how the rest of the app stores them (CLAUDE.md §29).

import type {
  UpsertGcCustomerInput,
  UpsertGcMandateMirrorInput,
  UpsertGcPaymentMirrorInput,
  UpsertGcPayoutInput,
  UpsertGcSubscriptionInput,
} from '@studymind/core/finance'

import type {
  GcCustomerResource,
  GcMandateResource,
  GcPaymentResource,
  GcPayoutResource,
  GcSubscriptionResource,
} from './types'
import { mapMandateStatus, mapPaymentStatus, mapSubscriptionStatus } from './types'

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function customerMirrorInput(
  resource: GcCustomerResource,
  opts: { autoMatch: boolean },
): UpsertGcCustomerInput {
  return {
    gcCustomerId: resource.id,
    email: resource.email ?? null,
    givenName: resource.given_name ?? null,
    familyName: resource.family_name ?? null,
    companyName: resource.company_name ?? null,
    phone: resource.phone_number ?? null,
    gcCreatedAt: parseDate(resource.created_at),
    autoMatch: opts.autoMatch,
  }
}

export function mandateMirrorInput(
  resource: GcMandateResource,
  opts: { familyId?: string | null } = {},
): UpsertGcMandateMirrorInput {
  return {
    gcMandateId: resource.id,
    state: mapMandateStatus(resource.status),
    gcCustomerId: resource.links.customer ?? null,
    reference: resource.reference ?? null,
    scheme: resource.scheme ?? null,
    nextPossibleChargeDate: parseDate(resource.next_possible_charge_date),
    gcCreatedAt: parseDate(resource.created_at),
    ...(opts.familyId !== undefined ? { familyId: opts.familyId } : {}),
  }
}

export function subscriptionMirrorInput(
  resource: GcSubscriptionResource,
  opts: { gcCustomerId?: string | null } = {},
): UpsertGcSubscriptionInput {
  const next = resource.upcoming_payments?.[0] ?? null
  return {
    gcSubscriptionId: resource.id,
    status: mapSubscriptionStatus(resource.status),
    amountMinor: resource.amount,
    currency: resource.currency,
    intervalUnit: resource.interval_unit,
    interval: resource.interval ?? 1,
    dayOfMonth: resource.day_of_month ?? null,
    name: resource.name ?? null,
    startDate: parseDate(resource.start_date),
    endDate: parseDate(resource.end_date),
    nextChargeAt: next ? parseDate(next.charge_date) : null,
    nextChargeMinor: next?.amount ?? null,
    totalPaymentCount: resource.count ?? null,
    metadata: resource.metadata ?? null,
    gcCreatedAt: parseDate(resource.created_at),
    gcMandateId: resource.links.mandate ?? null,
    ...(opts.gcCustomerId !== undefined ? { gcCustomerId: opts.gcCustomerId } : {}),
  }
}

export function paymentMirrorInput(
  resource: GcPaymentResource,
  opts: { gcCustomerId?: string | null } = {},
): UpsertGcPaymentMirrorInput {
  // GoCardless payments do not link the customer directly — callers resolve
  // it through the mandate mirror and pass it in.
  return {
    gcPaymentId: resource.id,
    status: mapPaymentStatus(resource.status),
    amountMinor: resource.amount,
    currency: resource.currency,
    description: resource.description ?? null,
    chargeDate: parseDate(resource.charge_date),
    gcCreatedAt: parseDate(resource.created_at),
    gcMandateId: resource.links.mandate ?? null,
    gcCustomerId: opts.gcCustomerId ?? resource.links.customer ?? null,
    gcSubscriptionId: resource.links.subscription ?? null,
    gcPayoutId: resource.links.payout ?? null,
  }
}

export function payoutMirrorInput(resource: GcPayoutResource): UpsertGcPayoutInput {
  return {
    gcPayoutId: resource.id,
    status: resource.status || 'pending',
    amountMinor: resource.amount,
    currency: resource.currency,
    deductedFeesMinor: resource.deducted_fees ?? null,
    reference: resource.reference ?? null,
    payoutType: resource.payout_type ?? null,
    arrivalDate: parseDate(resource.arrival_date),
    gcCreatedAt: parseDate(resource.created_at),
  }
}
