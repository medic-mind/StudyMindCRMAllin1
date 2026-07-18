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
  /** True when the link was made by the fuzzy pass (nickname / prefix / partial
   *  org name) — stamped on the record so the approximate link is auditable. */
  fuzzy?: boolean
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

/** Link target for a KNOWN contact id (e.g. one just auto-onboarded), with the
 *  same school-stamping the matcher applies (§12). */
export async function targetForContactId(contactId: string): Promise<SlackLinkTarget> {
  const businessAccountId = await primaryAccountForContact(contactId)
  return {
    kind: 'contact',
    contactId,
    ...(businessAccountId ? { businessAccountId } : {}),
    via: 'phone',
  }
}

/** Resolve a candidate (name / email / phone) to a Contact (and its school, if
 *  any), else to a B2B account directly. Null when nothing resolves. */
export async function resolveSlackLinkTarget(
  candidate: MatchCandidate,
): Promise<SlackLinkTarget | null> {
  // Fuzzy widening is on for Slack (nicknames, partial org names), always
  // behind the matcher's unambiguous-only guard (§3).
  const contact = await matchContactByCandidate(db, candidate, { fuzzy: true })
  if (contact.contactId) {
    const businessAccountId = await primaryAccountForContact(contact.contactId)
    return {
      kind: 'contact',
      contactId: contact.contactId,
      ...(businessAccountId ? { businessAccountId } : {}),
      via: contact.via,
      ...(contact.fuzzy ? { fuzzy: true } : {}),
    }
  }
  const account = await matchBusinessAccountByCandidate(db, candidate, { fuzzy: true })
  if (account.businessAccountId) {
    return {
      kind: 'account',
      businessAccountId: account.businessAccountId,
      via: account.via,
      ...(account.fuzzy ? { fuzzy: true } : {}),
    }
  }
  return null
}

/**
 * Resolve a list of deterministically-extracted name candidates to ONE target.
 * Each candidate goes through the same unambiguous-only resolver; the link is
 * made only when every candidate that resolves at all points at the SAME
 * entity. Two candidates resolving to two different people is ambiguity at the
 * message level — we park rather than guess (§3), exactly like the matcher's
 * own take:2 guard. Free (no AI); powers name-only matching when no AI
 * provider is configured.
 */
export async function resolveSlackLinkTargetFromNames(
  names: readonly string[],
): Promise<SlackLinkTarget | null> {
  let resolved: SlackLinkTarget | null = null
  for (const name of names) {
    const target = await resolveSlackLinkTarget({ name, email: null, phone: null })
    if (!target) continue
    if (!resolved) {
      resolved = target
      continue
    }
    if (resolved.kind === target.kind) {
      const same =
        resolved.contactId === target.contactId &&
        resolved.businessAccountId === target.businessAccountId
      if (!same) return null // two candidates → two different entities: ambiguous
      continue
    }
    // Mixed kinds are consistent when the person belongs to the named school
    // ("Aanya Sharma at Oakwood Primary") — keep the more specific contact
    // target. Anything else is ambiguous.
    const contactTarget: SlackLinkTarget = resolved.kind === 'contact' ? resolved : target
    const accountTarget: SlackLinkTarget = resolved.kind === 'account' ? resolved : target
    if (
      contactTarget.businessAccountId &&
      contactTarget.businessAccountId === accountTarget.businessAccountId
    ) {
      resolved = contactTarget
      continue
    }
    return null
  }
  return resolved
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
