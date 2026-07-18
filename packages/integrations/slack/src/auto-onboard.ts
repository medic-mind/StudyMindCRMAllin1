// Auto-onboard a customer from a Slack call summary (ADR 0043).
//
// The team's call-log format ("🇬🇧Aviral Sethi +447818953024 Medic Mind …")
// names a real person the team just SPOKE to, with a diallable number. When
// that number matches nobody in the CRM, parking the mention in a tray is the
// wrong altitude — a call summary is a record of a genuine human touch, the
// same standard as an Aircall call (§10) or a web enquiry (§16), so we create
// the lightweight Contact and file the message on their timeline. The phone is
// the gate: name-only chatter never creates anybody (§11's spam guard stands),
// and creation reuses the shared call resolver (`resolveOrCreateContactForCall`)
// so dedupe/fill-blanks/shared-line semantics are identical to Aircall —
// including NEVER auto-merging (§41.1).

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
  phoneE164: string
  name: string | null
  email: string | null
}

/** Pure decision: should this unmatched message create a Contact, and with
 *  what identity? Phone required; the name prefers the call-log header (works
 *  for lower-case names), else the first non-brand extracted candidate. */
export function onboardDecision(input: {
  messageText: string
  phone: string | null
  email: string | null
  nameCandidates: readonly string[]
  isBrandName: (name: string) => boolean
  isBrandEmail: (email: string) => boolean
}): OnboardDecision | null {
  if (!input.phone) return null
  const phoneE164 = normaliseSlackPhoneToE164(input.phone)
  if (!phoneE164) return null
  const headerName = callLogNameFromFirstLine(input.messageText)
  const name =
    [headerName, ...input.nameCandidates].find(
      (n): n is string => !!n && !input.isBrandName(n),
    ) ?? null
  const email = input.email && !input.isBrandEmail(input.email) ? input.email : null
  return { phoneE164, name, email }
}

/**
 * Create (or phone-match) the Contact for an unmatched phone-bearing message
 * and return it as a link target — null when the message shouldn't onboard
 * (no phone) or the number is a shared line (triage stays with a human).
 */
export async function autoOnboardContactForSlackMessage(input: {
  messageText: string
  phone: string | null
  email: string | null
  nameCandidates: readonly string[]
  requestId: string
}): Promise<SlackLinkTarget | null> {
  const brands = await loadOwnBrands()
  const decision = onboardDecision({
    messageText: input.messageText,
    phone: input.phone,
    email: input.email,
    nameCandidates: input.nameCandidates,
    isBrandName: (n) => isOwnBrandName(n, brands),
    isBrandEmail: (e) => isOwnBrandEmail(e, brands),
  })
  if (!decision) return null
  const { firstName, lastName } = decision.name
    ? splitDisplayName(decision.name)
    : { firstName: null, lastName: null }
  const res = await resolveOrCreateContactForCall(
    db,
    {
      phoneE164: decision.phoneE164,
      firstName,
      lastName,
      email: decision.email,
    },
    {
      referralSource: 'Slack call summary',
      actorId: null,
      requestId: input.requestId,
    },
  )
  if (!res.contactId) return null
  return targetForContactId(res.contactId)
}
