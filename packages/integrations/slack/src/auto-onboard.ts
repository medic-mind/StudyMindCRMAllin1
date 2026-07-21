// Auto-onboard a customer from a Slack call summary (ADR 0043, widened by the
// 2026-07 operator direction: no mention waits for a human).
//
// The team's call-log format ("🇬🇧Aviral Sethi +447818953024 Medic Mind …")
// names a real person the team just SPOKE to. When nothing in the CRM matches,
// parking the mention in a tray is the wrong altitude — a call summary is a
// record of a genuine human touch, the same standard as an Aircall call (§10)
// or a web enquiry (§16), so we create the lightweight Contact and file the
// message on their timeline. Identity tiers, strongest first:
//   1. PHONE — via the shared call resolver (`resolveOrCreateContactForCall`),
//      identical dedupe/fill-blanks/shared-line semantics to Aircall.
//   2. EMAIL — attach to the most recently active contact on that email
//      (ADR 0044's shared-identifier convention), else create.
//   3. FULL NAME (2+ words) — create, but ONLY when the caller flags the
//      channel as a call-log channel (#…callsummaries / #…complaints): generic
//      chatter never mints contacts (§11's spam guard, narrowed not dropped).
// Never auto-merges (§41.1).

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { splitDisplayName, resolveOrCreateContactForCall } from '@studymind/core/contact/from-call'
import { db } from '@studymind/db'

import { SLACK_EMOJI_CODE_RE, slackTextToPlain } from './extract'
import type { SlackLinkTarget } from './link-target'
import { targetForContactId } from './link-target'
import { isOwnBrandEmail, isOwnBrandName, loadOwnBrands } from './own-brands'

/**
 * Normalise a phone as pasted into Slack to E.164. Handles the team's habits:
 * the malformed "+44 07818…" paste, a dial code typed without the +, the UK
 * trunk-0 national form, and 00-prefixed international. Null when the digits
 * can't plausibly be a diallable number.
 */
export function normaliseSlackPhoneToE164(raw: string): string | null {
  const digits = raw.replace(/\D/gu, '')
  if (digits.length < 10 || digits.length > 15) return null
  if (digits.startsWith('440') && digits.length === 13) return `+44${digits.slice(3)}`
  if (digits.startsWith('00') && digits.length >= 12) return `+${digits.slice(2)}`
  if (digits.startsWith('0') && digits.length === 11) return `+44${digits.slice(1)}`
  return `+${digits}`
}

/**
 * The customer's name from a call-log first line — everything before the first
 * digit/plus ("kinza shahzad +4407490033312 …" → "kinza shahzad"). Handles the
 * lower-case names the proper-noun extractor can't see. Null when the segment
 * doesn't look like 1–4 name words.
 */
export function callLogNameFromFirstLine(messageText: string): string | null {
  const plain = slackTextToPlain(messageText).replace(SLACK_EMOJI_CODE_RE, ' ')
  const firstLine = plain
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!firstLine) return null
  // The header must actually carry the number — without one this is prose,
  // and its opening words are not a name.
  const beforePhone = /^([^+\d]*)[+\d]/u.exec(firstLine)?.[1]
  if (beforePhone === undefined) return null
  const tokens = beforePhone
    .replace(/[-–—•·,:|]+/gu, ' ')
    .split(/\s+/u)
    .filter((t) => /^[\p{L}'’.-]{2,}$/u.test(t))
  if (tokens.length < 1 || tokens.length > 4) return null
  return tokens.join(' ')
}

export interface OnboardDecision {
  /** Exactly one identity tier is the anchor; the others enrich the record. */
  phoneE164: string | null
  email: string | null
  name: string | null
}

/** Pure decision: should this unmatched message create/attach a Contact, and
 *  with what identity? Phone anchors when present; else a non-brand email;
 *  else — only when `allowNameOnly` (a call-log channel) — a FULL name
 *  (2+ words). The name prefers the call-log header (works for lower-case
 *  names), else the first non-brand extracted candidate. */
export function onboardDecision(input: {
  messageText: string
  phone: string | null
  email: string | null
  nameCandidates: readonly string[]
  allowNameOnly: boolean
  isBrandName: (name: string) => boolean
  isBrandEmail: (email: string) => boolean
}): OnboardDecision | null {
  const headerName = callLogNameFromFirstLine(input.messageText)
  const name =
    [headerName, ...input.nameCandidates].find(
      (n): n is string => !!n && !input.isBrandName(n),
    ) ?? null
  const email = input.email && !input.isBrandEmail(input.email) ? input.email : null

  const phoneE164 = input.phone ? normaliseSlackPhoneToE164(input.phone) : null
  if (phoneE164) return { phoneE164, email, name }
  if (email) return { phoneE164: null, email, name }
  // Name-only: a FULL name in a call-log channel is a genuine customer
  // reference (the operator's tray was full of exactly these); a single token
  // anywhere, or any name in a generic channel, still never creates anybody.
  if (input.allowNameOnly && name && name.trim().split(/\s+/u).length >= 2) {
    return { phoneE164: null, email: null, name }
  }
  return null
}

/**
 * Create (or match) the Contact for an unmatched message and return it as a
 * link target — null when the message shouldn't onboard (no usable identity,
 * or a shared phone line where triage stays with a human).
 */
export async function autoOnboardContactForSlackMessage(input: {
  messageText: string
  phone: string | null
  email: string | null
  nameCandidates: readonly string[]
  /** Unlocks the full-name-only creation tier. True for call-log channels
   *  (#…callsummaries/#…complaints) AND — since the 2026-07 operator direction
   *  — whenever the AI was confident about the customer it named, so a good AI
   *  guess creates the contact in any channel. */
  allowNameOnly?: boolean
  requestId: string
}): Promise<SlackLinkTarget | null> {
  const brands = await loadOwnBrands()
  const decision = onboardDecision({
    messageText: input.messageText,
    phone: input.phone,
    email: input.email,
    nameCandidates: input.nameCandidates,
    allowNameOnly: input.allowNameOnly ?? false,
    isBrandName: (n) => isOwnBrandName(n, brands),
    isBrandEmail: (e) => isOwnBrandEmail(e, brands),
  })
  if (!decision) return null
  const { firstName, lastName } = decision.name
    ? splitDisplayName(decision.name)
    : { firstName: null, lastName: null }

  // Tier 1 — phone: the shared call resolver (dedupe, fill-blanks, shared-line
  // park, §41.1).
  if (decision.phoneE164) {
    const res = await resolveOrCreateContactForCall(
      db,
      { phoneE164: decision.phoneE164, firstName, lastName, email: decision.email },
      { referralSource: 'Slack call summary', actorId: null, requestId: input.requestId },
    )
    if (!res.contactId) return null
    return targetForContactId(res.contactId)
  }

  // Tier 2 — email: attach to the most recently active contact on that email
  // (ADR 0044's shared-identifier convention — an annotation, never a merge),
  // filling blank names on an exact single match; else create.
  if (decision.email) {
    const matches = await db.contact.findMany({
      where: { email: { equals: decision.email, mode: 'insensitive' }, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, firstName: true, lastName: true },
      take: 5,
    })
    if (matches.length > 0) {
      const existing = matches[0]!
      if (matches.length === 1 && !existing.firstName && firstName) {
        await db.contact.update({
          where: { id: existing.id },
          data: { firstName, lastName },
        })
      }
      return targetForContactId(existing.id)
    }
  }

  // Create (email tier with no match, or the full-name-only tier — two
  // same-named contacts already failed the unique-name pass upstream, and per
  // ADR 0044 a fresh record beats guessing between them).
  const id = createId()
  await db.contact.create({
    data: {
      id,
      kind: 'unclassified',
      firstName,
      lastName,
      email: decision.email,
      referralSource: 'Slack call summary',
      createdById: null,
      updatedById: null,
    },
  })
  await writeAuditLogEntry(db, {
    actorId: null,
    requestId: input.requestId,
    action: 'contact.created',
    target: { type: 'Contact', id },
    after: {
      email: decision.email,
      firstName,
      lastName,
      referralSource: 'Slack call summary',
      autoCreatedFromSlack: true,
    },
  })
  return targetForContactId(id)
}
