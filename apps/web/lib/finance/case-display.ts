// Read-time display fallback for Direct Debit recovery cases, so a case is
// NEVER shown as "Unknown / no email" regardless of how it was created or
// whether the hourly identify-backfill has reached it yet.
//
// The data layer already onboards a CRM contact + seeds personName/chaseEmail
// from GoCardless (packages/jobs .../flag-dd-defaulters `resolveCaseIdentity`),
// but a case can be created by other paths (getOrCreateCase, a button on a
// sparse customer) or predate the fix. This resolves the person's name + email
// + phone straight from the case's GoCardless customer (and its plan name) at
// read time as a final belt-and-braces, so the chase list + case modal always
// show a real label. Batched — safe to call once per page.

import { gcCustomerDisplayName } from '@studymind/core/finance'
import type { Prisma, PrismaClient } from '@prisma/client'

type DbClient = PrismaClient | Prisma.TransactionClient

export interface CaseLike {
  id: string
  gcCustomerId: string | null
  gcSubscriptionId: string | null
}

export interface GcFallback {
  /** GoCardless customer name (given+family, else company). */
  gcName: string | null
  gcEmail: string | null
  gcPhone: string | null
  /** The plan/subscription name — usually embeds the person. */
  planName: string | null
}

const EMPTY: GcFallback = { gcName: null, gcEmail: null, gcPhone: null, planName: null }

/**
 * For each case, resolve the GoCardless display fallback: the customer's
 * name/email/phone (found directly or via the case's subscription) and the plan
 * name. Two batched queries total.
 */
export async function loadGcFallbackForCases(
  db: DbClient,
  cases: CaseLike[],
): Promise<Map<string, GcFallback>> {
  const out = new Map<string, GcFallback>()
  if (cases.length === 0) return out

  // 1. Subscriptions → plan name + (a customer id when the case lacks one).
  const subIds = [
    ...new Set(cases.map((c) => c.gcSubscriptionId).filter((v): v is string => Boolean(v))),
  ]
  const subs =
    subIds.length > 0
      ? await db.gcSubscription.findMany({
          where: { gcSubscriptionId: { in: subIds } },
          select: { gcSubscriptionId: true, name: true, gcCustomerId: true },
        })
      : []
  const subById = new Map(subs.map((s) => [s.gcSubscriptionId, s]))

  // 2. Customers → name/email/phone (case's own id, else via its subscription).
  const custIds = new Set<string>()
  for (const c of cases) {
    if (c.gcCustomerId) custIds.add(c.gcCustomerId)
    else if (c.gcSubscriptionId) {
      const s = subById.get(c.gcSubscriptionId)
      if (s?.gcCustomerId) custIds.add(s.gcCustomerId)
    }
  }
  const custs =
    custIds.size > 0
      ? await db.gcCustomer.findMany({
          where: { gcCustomerId: { in: [...custIds] } },
          select: {
            gcCustomerId: true,
            givenName: true,
            familyName: true,
            companyName: true,
            email: true,
            phone: true,
          },
        })
      : []
  const custById = new Map(custs.map((c) => [c.gcCustomerId, c]))

  for (const c of cases) {
    const sub = c.gcSubscriptionId ? subById.get(c.gcSubscriptionId) : null
    const custId = c.gcCustomerId ?? sub?.gcCustomerId ?? null
    const cust = custId ? custById.get(custId) : null
    out.set(c.id, {
      gcName: cust ? gcCustomerDisplayName(cust) : null,
      gcEmail: cust?.email?.trim() || null,
      gcPhone: cust?.phone?.trim() || null,
      planName: sub?.name?.trim() || null,
    })
  }
  return out
}

/** The single-case variant (case detail modal). */
export async function loadGcFallbackForCase(
  db: DbClient,
  c: CaseLike,
): Promise<GcFallback> {
  const map = await loadGcFallbackForCases(db, [c])
  return map.get(c.id) ?? EMPTY
}

/**
 * Compose the guaranteed display name for a case. Order: linked contact →
 * case's own person name → GoCardless customer name → plan name → any email →
 * any phone. Only truly identity-less cases fall through to "Unknown", which is
 * unreachable for a case backed by a plan or contact.
 */
export function composeCaseName(input: {
  contactName: string | null
  personName: string | null
  chaseEmail: string | null
  chasePhoneE164: string | null
  fallback: GcFallback
}): string {
  return (
    input.contactName ||
    input.personName ||
    input.fallback.gcName ||
    input.fallback.planName ||
    input.chaseEmail ||
    input.fallback.gcEmail ||
    input.chasePhoneE164 ||
    input.fallback.gcPhone ||
    'Unknown'
  )
}
