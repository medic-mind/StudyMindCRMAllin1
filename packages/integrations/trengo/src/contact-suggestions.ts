// Diff a Trengo `contact.updated` envelope against the current CRM Contact
// and emit a list of `ContactFieldSuggestion` writes for fields whose
// proposed value differs. Pure — no DB writes — so the heuristic can be
// unit-tested without a database.
//
// ADR 0020 Phase 6c. CLAUDE.md §3 ("AI/automation suggests, humans confirm").

import { createId } from '@paralleldrive/cuid2'

/** Subset of the Contact row this module needs to compute a diff. */
export interface ContactSnapshot {
  id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
}

/** The shape of `envelope.data.contact` we care about. */
export interface TrengoContactProposal {
  /** Full name. We split on the first space; everything before is treated as
   *  the first name, everything after as the last name. */
  name?: string | null
  email?: string | null
  /** E.164 with leading `+`. Trengo's webhook is already E.164 normalised
   *  for the channels we care about (whatsapp, sms). */
  phone?: string | null
}

export interface SuggestionWrite {
  /** New row id, generated up-front so the caller can audit-link it. */
  id: string
  contactId: string
  source: 'trengo'
  sourceEventId: string
  field: 'firstName' | 'lastName' | 'email' | 'phoneE164'
  /** Null when the proposal is to clear the field. */
  proposedValue: string | null
  /** The current Contact value at proposal time — captured here so the
   *  reviewer sees what they are overwriting even if the Contact changes
   *  before the review. */
  currentValue: string | null
}

/**
 * Compute the list of suggestion writes to emit for a single
 * `contact.updated` event. Empty list when the proposed values match the
 * current Contact (Trengo and CRM are already in sync).
 *
 * Normalisation rules:
 *  - `email` is trim + lowercase; an empty string becomes null.
 *  - `phone` is trim; only accepted when it starts with `+` (E.164). A bare
 *    UK number would parse ambiguously so we drop it rather than guess.
 *  - `name` is trim + split on the first space. A single token is treated
 *    as first-name only; last-name proposal is null in that case.
 */
export function buildContactSuggestionWrites(input: {
  current: ContactSnapshot
  proposal: TrengoContactProposal
  sourceEventId: string
}): SuggestionWrite[] {
  const writes: SuggestionWrite[] = []
  const { current, proposal, sourceEventId } = input

  // Email.
  const emailProposed = normaliseEmail(proposal.email)
  if (emailProposed !== undefined && emailProposed !== current.email) {
    writes.push(
      makeWrite(current.id, sourceEventId, 'email', emailProposed, current.email),
    )
  }

  // Phone — only E.164.
  const phoneProposed = normalisePhone(proposal.phone)
  if (phoneProposed !== undefined && phoneProposed !== current.phoneE164) {
    writes.push(
      makeWrite(
        current.id,
        sourceEventId,
        'phoneE164',
        phoneProposed,
        current.phoneE164,
      ),
    )
  }

  // Name split.
  const nameProposal = normaliseName(proposal.name)
  if (nameProposal !== undefined) {
    const { firstName, lastName } = nameProposal
    if (firstName !== current.firstName) {
      writes.push(
        makeWrite(
          current.id,
          sourceEventId,
          'firstName',
          firstName,
          current.firstName,
        ),
      )
    }
    if (lastName !== current.lastName) {
      writes.push(
        makeWrite(
          current.id,
          sourceEventId,
          'lastName',
          lastName,
          current.lastName,
        ),
      )
    }
  }

  return writes
}

function makeWrite(
  contactId: string,
  sourceEventId: string,
  field: SuggestionWrite['field'],
  proposedValue: string | null,
  currentValue: string | null,
): SuggestionWrite {
  return {
    id: createId(),
    contactId,
    source: 'trengo',
    sourceEventId,
    field,
    proposedValue,
    currentValue,
  }
}

/**
 * Normalise a proposed email. `undefined` means "no proposal on this field"
 * (don't write a suggestion); `null` means "proposal is to clear" — the
 * webhook deliberately sent an empty/null email.
 */
function normaliseEmail(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  const trimmed = raw.trim().toLowerCase()
  return trimmed === '' ? null : trimmed
}

function normalisePhone(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  // Reject anything that does not look like E.164 — a bare local number
  // would parse ambiguously into the contact's record. Better to drop the
  // proposal than guess. CLAUDE.md §29 (phone numbers are E.164).
  if (!trimmed.startsWith('+')) return undefined
  return trimmed
}

interface NameProposal {
  firstName: string | null
  lastName: string | null
}

function normaliseName(
  raw: string | null | undefined,
): NameProposal | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return { firstName: null, lastName: null }
  const trimmed = raw.trim()
  if (trimmed === '') return { firstName: null, lastName: null }
  const firstSpace = trimmed.indexOf(' ')
  if (firstSpace === -1) {
    // Single token — treat as first name. We don't propose to clear the
    // existing lastName because a single-token name does not assert
    // anything about the surname.
    return { firstName: trimmed, lastName: null }
  }
  return {
    firstName: trimmed.slice(0, firstSpace),
    lastName: trimmed.slice(firstSpace + 1).trim() || null,
  }
}
