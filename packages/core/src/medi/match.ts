// Pure contact-match decision for a Medi Platform account import (ADR 0037).
// Mirrors the lead matcher (packages/core/src/lead/match.ts) but keyed on
// EMAIL first — a portal account always carries one — with phone as a careful
// secondary. We never auto-merge (CLAUDE.md §3, §41.1): ambiguity reuses the
// oldest record and flags it for a human, and a phone that belongs to a
// *different* email is treated as a different person (shared family line).

export interface MediContactCandidate {
  id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
}

export type MediMatchDecision =
  | { kind: 'reuse'; contactId: string; matchedBy: 'email' | 'phone'; ambiguous: boolean }
  | { kind: 'create' }

export interface MediMatchInput {
  email: string | null
  phoneE164: string | null
  /** Contacts matching the email exactly, oldest first. */
  byEmail: MediContactCandidate[]
  /** Contacts matching the phone exactly, oldest first. */
  byPhone: MediContactCandidate[]
}

/**
 * Decide whether a Medi account maps to an existing Contact or a new one.
 *
 * - 1 email match  → reuse it (the common case).
 * - >1 email match → reuse the oldest, flag `ambiguous` so staff merge the
 *                    pre-existing duplicates (we never auto-merge).
 * - no email match → adopt a *single* phone match only when that contact has
 *                    no email, or the same email — otherwise the account's
 *                    distinct email identity wins and we create a fresh record
 *                    (a shared landline must not fuse a parent and a student).
 * - otherwise      → create.
 */
export function decideMediMatch(input: MediMatchInput): MediMatchDecision {
  const { email, phoneE164, byEmail, byPhone } = input

  if (email && byEmail.length === 1) {
    return { kind: 'reuse', contactId: byEmail[0]!.id, matchedBy: 'email', ambiguous: false }
  }
  if (email && byEmail.length > 1) {
    return { kind: 'reuse', contactId: byEmail[0]!.id, matchedBy: 'email', ambiguous: true }
  }

  if (phoneE164 && byPhone.length === 1) {
    const candidate = byPhone[0]!
    const sameOrBlankEmail =
      !candidate.email ||
      (email != null && candidate.email.toLowerCase() === email.toLowerCase())
    if (sameOrBlankEmail) {
      return { kind: 'reuse', contactId: candidate.id, matchedBy: 'phone', ambiguous: false }
    }
  }

  return { kind: 'create' }
}
