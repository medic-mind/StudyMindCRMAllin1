// Where a resolved Slack mention is filed. Shared by the live ingest job
// (jobs.ts), the recurring relink job (relink.ts) and the backfill, so all
// three file mentions the same way.
//
// Two cases, both deterministic / free / unambiguous-only (§3 never guess):
//
//   1. A named PERSON resolves to a Contact. We stamp `contactId` AND — when
//      that contact belongs to a B2B account (school / partnership via
//      BusinessAccountContact) — ALSO `businessAccountId`, so the mention shows
//      on BOTH the customer's timeline and the school's Activity. This mirrors
//      the established Gmail convention (primaryAccountByContact) so Slack,
//      email, notes and tasks all surface on a school the same way.
//   2. No person matches, but the message names the ORG itself (org email,
//      email domain, phone or name) → we stamp `businessAccountId` only, so a
//      note about a school with no known contact still lands on the school.

import { db } from '@studymind/db'

import { matchBusinessAccountByCandidate, matchContactByCandidate, type MatchCandidate } from './match'

export type SlackLinkTarget = {
  /** 'contact' when a person matched (may also carry their school);
   *  'account' when only the org matched. */
  kind: 'contact' | 'account'
  contactId?: string
  businessAccountId?: string
  via: string | null
}

/**
 * The single B2B account a contact primarily belongs to, or null. A contact can
 * belong to several (BusinessAccountContact is M:N); we pick the lowest accountId
 * deterministically so one mention lands on one account timeline rather than
 * fanning out — same rule as the Gmail link resolver.
 */
async function primaryAccountForContact(contactId: string): Promise<string | null> {
  const link = await db.businessAccountContact.findFirst({
    where: { contactId },
    select: { accountId: true },
    orderBy: { accountId: 'asc' },
  })
  return link?.accountId ?? null
}

/** Resolve a candidate (name / email / phone) to a Contact (and its school, if
 *  any), else to a B2B account directly. Null when nothing resolves. */
export async function resolveSlackLinkTarget(
  candidate: MatchCandidate,
): Promise<SlackLinkTarget | null> {
  const contact = await matchContactByCandidate(db, candidate)
  if (contact.contactId) {
    const businessAccountId = await primaryAccountForContact(contact.contactId)
    return {
      kind: 'contact',
      contactId: contact.contactId,
      ...(businessAccountId ? { businessAccountId } : {}),
      via: contact.via,
    }
  }
  const account = await matchBusinessAccountByCandidate(db, candidate)
  if (account.businessAccountId) {
    return { kind: 'account', businessAccountId: account.businessAccountId, via: account.via }
  }
  return null
}

/** The interaction foreign keys for a target — `contactId` and/or
 *  `businessAccountId`, whichever the target carries. */
export function targetForeignKey(
  target: SlackLinkTarget,
): { contactId?: string; businessAccountId?: string } {
  return {
    ...(target.contactId ? { contactId: target.contactId } : {}),
    ...(target.businessAccountId ? { businessAccountId: target.businessAccountId } : {}),
  }
}

/** The audit-log target descriptor — the Contact is the primary entity when a
 *  person matched, otherwise the account. */
export function targetAuditTarget(
  target: SlackLinkTarget,
): { type: 'Contact' | 'BusinessAccount'; id: string } {
  if (target.contactId) return { type: 'Contact', id: target.contactId }
  return { type: 'BusinessAccount', id: target.businessAccountId! }
}
