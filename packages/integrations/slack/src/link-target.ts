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
 * Each candidate goes through the same unambiguous-only resolver, then we
 * collapse the results:
 *
 *   - Two or more DIFFERENT people (contacts) named in one message is genuine
 *     ambiguity — we don't know which the mention is really about, so we park
 *     it for a human (§3, "never guess between two people").
 *   - Exactly ONE person resolved is who the message is about. Any orgs that
 *     also resolved (the person's own school, a partner mentioned in passing,
 *     a co-named tutor/staff member who isn't a contact) collapse to that one
 *     person — the contact is the more specific, correct home and already
 *     carries its own school stamp. This is the fix for "a call summary that
 *     names the parent AND their school (or a tutor) never linked": previously
 *     any second resolving entity parked the whole message.
 *   - No person and exactly one org → file it on that org's timeline.
 *   - No person and two+ orgs (or nothing) → unresolved / ambiguous.
 *
 * Free (no AI); powers name-only matching when no AI provider is configured.
 */
export async function resolveSlackLinkTargetFromNames(
  names: readonly string[],
): Promise<SlackLinkTarget | null> {
  const contactsById = new Map<string, SlackLinkTarget>()
  const accountsById = new Map<string, SlackLinkTarget>()
  for (const name of names) {
    const target = await resolveSlackLinkTarget({ name, email: null, phone: null })
    if (!target) continue
    if (target.contactId) contactsById.set(target.contactId, target)
    else if (target.businessAccountId) accountsById.set(target.businessAccountId, target)
  }
  // Two or more distinct people named → genuine ambiguity, park (§3).
  if (contactsById.size >= 2) return null
  // Exactly one person → that's the subject; orgs collapse into them.
  if (contactsById.size === 1) return [...contactsById.values()][0]!
  // No person, exactly one org named → file on that org.
  if (accountsById.size === 1) return [...accountsById.values()][0]!
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
