// Resolve (or create) the Contact a phone call belongs to. Shared by call
// integrations (Aircall today; Google Voice when its inbound pipeline lands)
// so an unmatched call never ends up orphaned — we key a lightweight Contact
// on the counterparty phone number and save whatever caller name the provider
// gave us, so the call is logged against a real record from the first ring.
//
// This is the deliberate call-channel analogue of the web-lead auto-onboard
// exception (CLAUDE.md §16/§11): a call is a genuine human touch, not the spam
// route §11 guards against. We still NEVER auto-merge (§41.1) — a number shared
// across several contacts (a family landline) returns `triageRequired` and we
// leave the link for an agent to assign rather than guessing.
//
// `packages/core` cannot import integration clients, so this is db + audit only
// and is exported via its own path (./contact/from-call), not the pure index.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

type Db = PrismaClient | Prisma.TransactionClient

/** Auto-created call contacts start `unclassified` — an agent classifies them
 * (parent / student / …) rather than the system assuming. Mirrors the lead
 * funnel's default (ADR 0023). */
const DEFAULT_CALL_CONTACT_KIND = 'unclassified' as const

export interface CallParty {
  /** E.164 counterparty number — the key we match + create on. */
  phoneE164: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
}

export interface ResolveCallContactResult {
  contactId: string | null
  /** Resolved Family when the matched contacts share exactly one. */
  familyId: string | null
  /** Multiple contacts share the number — leave the link for an agent. */
  triageRequired: boolean
  /** True when this call created a brand-new Contact. */
  created: boolean
}

export interface ResolveCallContactOptions {
  /** Stamped onto a newly-created Contact's `referralSource`, e.g. "Aircall". */
  referralSource: string
  /** Null for system/webhook writes. */
  actorId: string | null
  requestId: string
}

/** Split a single display name into first / last on the first space. */
export function splitDisplayName(full: string): { firstName: string; lastName: string | null } {
  const trimmed = full.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return { firstName: '', lastName: null }
  const idx = trimmed.indexOf(' ')
  if (idx === -1) return { firstName: trimmed, lastName: null }
  return { firstName: trimmed.slice(0, idx), lastName: trimmed.slice(idx + 1) }
}

function clampName(value: string | null | undefined): string | null {
  if (!value) return null
  const v = value.trim()
  return v.length === 0 ? null : v.slice(0, 120)
}

/**
 * Find the Contact for a call's counterparty by phone, or create one.
 *
 * - 0 matches → create a Contact (phone + any caller name/email), audited.
 * - 1 match   → reuse it, and backfill blank name/email from the caller
 *               details (never overwriting an existing value — §3).
 * - >1 match  → shared line: return the shared Family (if any) and
 *               `triageRequired`, never auto-merging (§41.1).
 */
export async function resolveOrCreateContactForCall(
  db: Db,
  party: CallParty,
  opts: ResolveCallContactOptions,
): Promise<ResolveCallContactResult> {
  const phone = party.phoneE164.trim()
  if (!phone.startsWith('+')) {
    return { contactId: null, familyId: null, triageRequired: false, created: false }
  }

  const contacts = await db.contact.findMany({
    where: { phoneE164: phone, deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      familyMembers: { select: { familyId: true } },
      billingForFamily: { select: { id: true } },
    },
  })

  const familyIds = new Set<string>()
  for (const c of contacts) {
    for (const m of c.familyMembers) familyIds.add(m.familyId)
    for (const f of c.billingForFamily) familyIds.add(f.id)
  }
  const sharedFamilyId = familyIds.size === 1 ? ([...familyIds][0] ?? null) : null

  // Shared line — never guess which person it was (§41.1).
  if (contacts.length > 1) {
    return { contactId: null, familyId: sharedFamilyId, triageRequired: true, created: false }
  }

  const firstName = clampName(party.firstName)
  const lastName = clampName(party.lastName)
  const email = party.email?.trim() || null

  // Exactly one match — reuse and fill blanks only (never overwrite).
  if (contacts.length === 1) {
    const existing = contacts[0]!
    const patch: Prisma.ContactUpdateInput = {}
    if (!existing.firstName && firstName) patch.firstName = firstName
    if (!existing.lastName && lastName) patch.lastName = lastName
    if (!existing.email && email) patch.email = email

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
        },
        after: { ...patch, source: opts.referralSource },
      })
    }
    return { contactId: existing.id, familyId: sharedFamilyId, triageRequired: false, created: false }
  }

  // No match — create a lightweight Contact keyed on the phone.
  const id = createId()
  await db.contact.create({
    data: {
      id,
      kind: DEFAULT_CALL_CONTACT_KIND,
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
      phoneE164: phone,
      firstName,
      lastName,
      email,
      referralSource: opts.referralSource,
      autoCreatedFromCall: true,
    },
  })
  return { contactId: id, familyId: null, triageRequired: false, created: true }
}
