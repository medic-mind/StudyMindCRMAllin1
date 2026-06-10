// Resolve (or create) the Contact for a Medi Platform (UCAT portal) account
// (ADR 0037). The account-channel sibling of ../contact/from-call.ts, but keyed
// primarily on EMAIL — a portal account always has one — with phone as a
// secondary key. Reuse + backfill blanks (never overwrite, §3); never
// auto-merge ambiguous matches (§41.1).
//
// Because the dedupe key (lowercased email / E.164 phone) is exactly what the
// lead funnel (packages/core/src/lead/match.ts) and the call resolver match on,
// a Contact created here is automatically found — and merely annotated — by a
// later web lead or missed call, so those channels never duplicate the record.
//
// `packages/core` cannot import integration clients, so this is db + audit only
// and is exported via its own path (./contact/from-medi), not the pure index.

import { createId } from '@paralleldrive/cuid2'
import type { ContactKind, Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { decideMediMatch, type MediContactCandidate } from '../medi/match'
import type { NormalisedMediParty } from '../medi/types'

type Db = PrismaClient | Prisma.TransactionClient

export interface ResolveMediContactResult {
  contactId: string
  /** True when this import created a brand-new Contact. */
  created: boolean
  matchedBy: 'email' | 'phone' | null
  /** Pre-existing duplicates detected — left for a human to merge (§41.1). */
  triageRequired: boolean
}

export interface ResolveMediContactOptions {
  /** Stamped onto a newly-created Contact's `referralSource`. */
  referralSource: string
  /** `kind` for a NEWLY created Contact — an existing one keeps its own. */
  kind: ContactKind
  /** Null for system/webhook writes. */
  actorId: string | null
  requestId: string
}

function clampName(value: string | null | undefined): string | null {
  if (!value) return null
  const v = value.trim()
  return v.length === 0 ? null : v.slice(0, 120)
}

/**
 * Find the Contact for a Medi account by email (then phone), or create one.
 *
 * Returns null only when the party carries neither an email nor a phone — there
 * is nothing to key on, so the caller skips it rather than create a ghost.
 */
export async function resolveOrCreateContactForMediAccount(
  db: Db,
  party: NormalisedMediParty,
  opts: ResolveMediContactOptions,
): Promise<ResolveMediContactResult | null> {
  const email = party.email?.trim().toLowerCase() || null
  const phone = party.phoneE164?.trim() || null
  if (!email && !phone) return null

  const select = {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phoneE164: true,
  } as const

  const byEmail: MediContactCandidate[] = email
    ? await db.contact.findMany({
        where: { email, deletedAt: null },
        select,
        orderBy: { createdAt: 'asc' },
      })
    : []

  // Only pay for the phone lookup when the email did not already resolve.
  const byPhone: MediContactCandidate[] =
    phone && byEmail.length === 0
      ? await db.contact.findMany({
          where: { phoneE164: phone, deletedAt: null },
          select,
          orderBy: { createdAt: 'asc' },
        })
      : []

  const decision = decideMediMatch({ email, phoneE164: phone, byEmail, byPhone })

  const firstName = clampName(party.firstName)
  const lastName = clampName(party.lastName)

  if (decision.kind === 'reuse') {
    const existing = [...byEmail, ...byPhone].find((c) => c.id === decision.contactId)!
    const patch: Prisma.ContactUpdateInput = {}
    if (!existing.firstName && firstName) patch.firstName = firstName
    if (!existing.lastName && lastName) patch.lastName = lastName
    if (!existing.email && email) patch.email = email
    if (!existing.phoneE164 && phone) patch.phoneE164 = phone

    if (Object.keys(patch).length > 0) {
      patch.updatedById = opts.actorId
      await db.contact.update({ where: { id: existing.id }, data: patch })
      await writeAuditLogEntry(db, {
        actorId: opts.actorId,
        requestId: opts.requestId,
        action: 'contact.updated',
        target: { type: 'Contact', id: existing.id },
        before: {
          firstName: existing.firstName,
          lastName: existing.lastName,
          email: existing.email,
          phoneE164: existing.phoneE164,
        },
        after: { ...patch, source: opts.referralSource },
      })
    }
    return {
      contactId: existing.id,
      created: false,
      matchedBy: decision.matchedBy,
      triageRequired: decision.ambiguous,
    }
  }

  // No match — create a Contact keyed on the email/phone.
  const id = createId()
  await db.contact.create({
    data: {
      id,
      kind: opts.kind,
      firstName,
      lastName,
      email,
      phoneE164: phone,
      referralSource: opts.referralSource,
      createdById: opts.actorId,
      updatedById: opts.actorId,
    },
  })
  await writeAuditLogEntry(db, {
    actorId: opts.actorId,
    requestId: opts.requestId,
    action: 'contact.created',
    target: { type: 'Contact', id },
    after: {
      email,
      phoneE164: phone,
      firstName,
      lastName,
      kind: opts.kind,
      referralSource: opts.referralSource,
      autoCreatedFromMedi: true,
    },
  })
  return { contactId: id, created: true, matchedBy: null, triageRequired: false }
}
