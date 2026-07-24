// Auto-onboard a GoCardless customer into the CRM (ADR 0038 / ADR 0045).
//
// Direct Debit customers are REAL paying customers with a money relationship —
// the strongest possible case for having a CRM record. Yet most of them predate
// the CRM and were never onboarded, so a cancelled/underpaid plan surfaces a
// recovery case with no linked contact: "Unknown · no email · no phone · not in
// CRM", even though GoCardless holds their name and email the whole time.
//
// This resolver closes that gap for the recovery workflow. Given a GoCardless
// customer it:
//   1. returns the already-linked CRM contact when there is one;
//   2. links an EXISTING CRM contact that matches the customer's email/phone
//      (never creating a duplicate — attaches to the most-recently-updated when
//      several share the identifier, an annotation, never a merge §41.1);
//   3. otherwise CREATES a lightweight CRM contact from the GoCardless identity
//      (name + email + phone) and links the customer to it.
//
// This is the operator-authorised Direct-Debit analogue of the call-channel
// auto-onboard (§10, `resolveOrCreateContactForCall`) and the Trengo-import
// exception (§11) — a paid Direct Debit is a genuine relationship, not the spam
// route §11 guards against. Linking propagates the Family to the customer's
// mandates via `linkGcCustomer`, so reconciliation picks them up.
//
// `packages/core` cannot import integration clients, so this is db + audit only
// and is reached through the finance barrel (which already exports db helpers).

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { phoneKey } from '../contact/duplicates'
import { splitDisplayName } from '../contact/from-call'

import { linkGcCustomer } from './gc-mirror'

type Db = PrismaClient | Prisma.TransactionClient

/** Human-readable display name for a GoCardless customer: given + family, else
 *  the company name. Null when the customer has no name at all. */
export function gcCustomerDisplayName(c: {
  givenName?: string | null
  familyName?: string | null
  companyName?: string | null
}): string | null {
  const person = [c.givenName, c.familyName]
    .map((v) => v?.trim() ?? '')
    .filter((v) => v.length > 0)
    .join(' ')
    .trim()
  if (person) return person
  const company = c.companyName?.trim()
  return company && company.length > 0 ? company : null
}

export interface GcOnboardResult {
  /** The resolved / created CRM contact, or null when the customer had no
   *  identifier at all to create one from (extremely rare). */
  contactId: string | null
  /** True when this call created a brand-new CRM contact. */
  created: boolean
  /** True when this call set the customer→contact link (created or matched). */
  linked: boolean
  /** GoCardless display fields, so a caller can still show the real name/email
   *  on a recovery case even in the (rare) no-contact path. */
  displayName: string | null
  email: string | null
  phone: string | null
}

export interface GcOnboardOptions {
  /** Null for system/cron writes. */
  actorId: string | null
  /** Stamped onto a newly-created contact's `referralSource`. */
  referralSource?: string
}

const DEFAULT_REFERRAL_SOURCE = 'GoCardless'

/**
 * Resolve (or create) the CRM contact for a GoCardless customer. Idempotent —
 * once the customer is linked, re-runs return the same contact without creating
 * anything. The audit `requestId` is derived from the customer id so retries
 * dedupe. See the module header for the linking precedence.
 */
export async function resolveOrCreateContactForGcCustomer(
  db: Db,
  input: { gcCustomerId: string },
  opts: GcOnboardOptions,
): Promise<GcOnboardResult> {
  const customer = await db.gcCustomer.findUnique({
    where: { gcCustomerId: input.gcCustomerId },
    select: {
      email: true,
      givenName: true,
      familyName: true,
      companyName: true,
      phone: true,
      contactId: true,
    },
  })
  if (!customer) {
    return { contactId: null, created: false, linked: false, displayName: null, email: null, phone: null }
  }

  const displayName = gcCustomerDisplayName(customer)
  const email = customer.email?.trim() || null
  const phone = customer.phone?.trim() || null
  const base = { displayName, email, phone }
  const requestId = `gc-onboard:${input.gcCustomerId}`
  const referralSource = opts.referralSource ?? DEFAULT_REFERRAL_SOURCE

  // 1. Already linked to a live contact — nothing to do.
  if (customer.contactId) {
    const live = await db.contact.findFirst({
      where: { id: customer.contactId, deletedAt: null },
      select: { id: true },
    })
    if (live) return { contactId: live.id, created: false, linked: false, ...base }
    // The link points at a deleted/missing contact — re-resolve below.
  }

  // 2. Existing CRM contact(s) matching the email or phone. Match, never create
  // a duplicate. `findContactForGcCustomer` bails on ambiguity (§41.1); here the
  // operator wants the customer LINKED, so on 2+ matches we attach to the most
  // recently updated one (an annotation, not a merge — the auto-merge cron then
  // collapses the cluster, §37) and stamp it in the audit.
  const or: Prisma.ContactWhereInput[] = []
  if (email) or.push({ email: { equals: email, mode: 'insensitive' } })
  const pk = phone ? phoneKey(phone) : null
  if (pk) or.push({ phoneE164: { endsWith: pk } })
  const matches =
    or.length > 0
      ? await db.contact.findMany({
          where: { deletedAt: null, OR: or },
          select: { id: true },
          orderBy: { updatedAt: 'desc' },
          take: 5,
        })
      : []

  if (matches.length >= 1) {
    const targetId = matches[0]!.id
    await linkGcCustomer(db, { gcCustomerId: input.gcCustomerId, contactId: targetId })
    await writeAuditLogEntry(db, {
      actorId: opts.actorId,
      requestId: `${requestId}:link`,
      action: 'gocardless.customer.auto_linked',
      target: { type: 'GcCustomer', id: input.gcCustomerId },
      after: { contactId: targetId, via: matches.length > 1 ? 'match_ambiguous_recent' : 'match' },
    })
    return { contactId: targetId, created: false, linked: true, ...base }
  }

  // 3. No CRM contact yet — auto-onboard from the GoCardless identity. Need at
  // least one identifier to make a meaningful record (never a ghost).
  if (!email && !phone && !displayName) {
    return { contactId: null, created: false, linked: false, ...base }
  }

  const { firstName, lastName } = displayName
    ? splitDisplayName(displayName)
    : { firstName: '', lastName: null }
  const id = createId()
  await db.contact.create({
    data: {
      id,
      kind: 'unclassified',
      firstName: firstName || null,
      lastName,
      email,
      // GoCardless stores the customer phone in E.164 (schema note on GcCustomer).
      phoneE164: phone,
      referralSource,
      createdById: opts.actorId,
      updatedById: opts.actorId,
    },
  })
  await writeAuditLogEntry(db, {
    actorId: opts.actorId,
    requestId: `${requestId}:create`,
    action: 'contact.created',
    target: { type: 'Contact', id },
    after: {
      firstName,
      lastName,
      email,
      phoneE164: phone,
      referralSource,
      autoCreatedFromGocardless: true,
      gcCustomerId: input.gcCustomerId,
    },
  })
  // Link the customer → propagates the Family to its mandates for reconciliation.
  await linkGcCustomer(db, { gcCustomerId: input.gcCustomerId, contactId: id })
  await writeAuditLogEntry(db, {
    actorId: opts.actorId,
    requestId: `${requestId}:link`,
    action: 'gocardless.customer.auto_linked',
    target: { type: 'GcCustomer', id: input.gcCustomerId },
    after: { contactId: id, via: 'created' },
  })
  return { contactId: id, created: true, linked: true, ...base }
}
