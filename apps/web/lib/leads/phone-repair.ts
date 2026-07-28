// Retroactive phone-number repair for the "Invalid number" board (ADR 0023
// follow-up). Scans the contacts backing cards on that board and re-derives the
// correct phone number from each contact's ORIGINAL enquiry (`Lead.rawPayload`,
// which still carries the "Country code: +44"/"+964" the enquirer gave) using
// the CORRECTED resolver. Returns only confident corrections — a customer-stated
// country code / phone dial code that differs from the wrong number stored. The
// per-contact decision is the pure `proposePhoneRepair` (packages/core); this
// file just gathers the rows. Read-only — the router owns the audited writes.

import type { PrismaClient } from '@prisma/client'

import { proposePhoneRepair } from '@studymind/core/lead'

/** The seeded "Invalid number" board (migration 20260601150000). */
export const INVALID_NUMBER_BOARD_ID = 'board_seed_invalid_number'

export interface PhoneRepairChange {
  contactId: string
  name: string
  /** The wrong number currently stored (null if none). */
  current: string | null
  /** The corrected E.164 re-derived from the original enquiry. */
  proposed: string
  /** Resolved country name (fills a blank Contact.country on apply). */
  country: string | null
  /** Which customer-stated signal produced the correction. */
  source: 'form' | 'phone_dial'
}

export interface PhoneRepairScan {
  changes: PhoneRepairChange[]
  /** Distinct contacts backing live cards on the Invalid number board. */
  contactCount: number
  /** Board contacts with no original enquiry to re-derive from (e.g. added
   * from Todoist / a call) — these must be fixed by hand. */
  withoutEnquiryData: number
}

/**
 * Scan the Invalid number board and return the confident phone corrections
 * derivable from each contact's original web enquiry. Bounded by `limit`.
 */
export async function scanInvalidNumberRepairs(
  db: PrismaClient,
  opts: { limit?: number } = {},
): Promise<PhoneRepairScan> {
  const limit = opts.limit ?? 1000

  const cards = await db.card.findMany({
    where: { boardId: INVALID_NUMBER_BOARD_ID, archivedAt: null },
    select: { contactId: true },
  })
  const contactIds = [...new Set(cards.map((c) => c.contactId))]
  if (contactIds.length === 0) {
    return { changes: [], contactCount: 0, withoutEnquiryData: 0 }
  }

  const contacts = await db.contact.findMany({
    where: { id: { in: contactIds }, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true, phoneE164: true },
  })
  const leads = await db.lead.findMany({
    where: { convertedToContactId: { in: contactIds }, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { convertedToContactId: true, rawPayload: true },
  })
  const leadsByContact = new Map<string, unknown[]>()
  for (const l of leads) {
    if (!l.convertedToContactId) continue
    const arr = leadsByContact.get(l.convertedToContactId) ?? []
    arr.push(l.rawPayload)
    leadsByContact.set(l.convertedToContactId, arr)
  }

  const changes: PhoneRepairChange[] = []
  let withoutEnquiryData = 0
  for (const c of contacts) {
    const payloads = leadsByContact.get(c.id) ?? []
    if (payloads.length === 0) {
      withoutEnquiryData += 1
      continue
    }
    if (changes.length >= limit) continue
    // Newest enquiry first; take the first payload that yields a confident fix.
    for (const rawPayload of payloads) {
      const proposal = await proposePhoneRepair({ currentPhoneE164: c.phoneE164, rawPayload })
      if (!proposal) continue
      changes.push({
        contactId: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.email || 'Contact',
        current: proposal.currentPhoneE164,
        proposed: proposal.proposedPhoneE164,
        country: proposal.proposedCountry,
        source: proposal.countrySource,
      })
      break
    }
  }

  return { changes, contactCount: contacts.length, withoutEnquiryData }
}
