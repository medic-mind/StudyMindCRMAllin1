// Normalisation for inbound account-sync payloads from the Medi Platform
// (the Medic Mind UCAT portal). The portal POSTs a `user.registered` event to
// the CRM's POST /api/contacts receiver whenever someone creates an account;
// we turn that into a Contact (ADR 0037). This is the account-channel analogue
// of the web-lead auto-onboard exception (CLAUDE.md §16): a real, named person
// created an account, so we want them in the CRM as a Contact — not the §11
// spam route, and deliberately NOT a board card / pipeline entry.
//
// Pure + dependency-light so it unit-tests without a DB. The resolver that
// writes Contacts lives in ../contact/from-medi.ts; the idempotent
// orchestration lives in @studymind/jobs/medi/process-account.

import { z } from 'zod'

/** One human in the payload — the account holder, or a named related contact. */
const partySchema = z
  .object({
    name: z.string().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    phone_country: z.string().nullish(),
    relation: z.string().nullish(),
  })
  .passthrough()

/**
 * The shape the portal sends (server/util/crm.js → `crmSync('user.registered', …)`).
 * Tolerant by design — extra fields pass through, only `user.id` + `user.email`
 * are load-bearing. We never hardcode an exhaustive field list so a portal-side
 * payload addition never breaks ingestion (mirrors the lead normaliser, §16).
 */
export const mediAccountPayloadSchema = z
  .object({
    event: z.string().nullish(),
    user: z
      .object({
        id: z.union([z.string(), z.number()]),
        email: z.string(),
        name: z.string().nullish(),
        role: z.string().nullish(),
        phone: z.string().nullish(),
        phone_country: z.string().nullish(),
        country: z.string().nullish(),
      })
      .passthrough(),
    contact: partySchema.nullish(),
    signup_ip: z.string().nullish(),
    user_agent: z.string().nullish(),
  })
  .passthrough()

export type MediAccountPayload = z.infer<typeof mediAccountPayloadSchema>

/** A normalised person ready for the Contact resolver. */
export interface NormalisedMediParty {
  firstName: string | null
  lastName: string | null
  /** Lowercased, trimmed; null when absent/blank. */
  email: string | null
  /** E.164 (`+…`); null when absent or too short to be a real number. */
  phoneE164: string | null
}

export interface NormalisedMediRelatedParty extends NormalisedMediParty {
  /** "parent_of_student" | "student_of_parent" | … (the portal's relation). */
  relation: string | null
}

export interface NormalisedMediAccount {
  /** The portal event ("user.registered"); defaults to that when omitted. */
  event: string
  /** The portal's stable user id — the idempotency key for the import. */
  mediUserId: string
  /** Self-declared role: student | parent | teacher | … (null if absent). */
  role: string | null
  country: string | null
  account: NormalisedMediParty
  /** The named parent/student counterpart, if the signup supplied one. */
  related: NormalisedMediRelatedParty | null
}

function normaliseEmail(value: string | null | undefined): string | null {
  if (!value) return null
  const v = value.trim().toLowerCase()
  // Cheap shape check — keep it permissive (the portal already validates).
  if (v.length === 0 || v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null
  return v
}

/** Coerce to E.164: strip spaces, ensure a leading `+`, require >= 7 digits. */
function normalisePhoneE164(value: string | null | undefined): string | null {
  if (!value) return null
  const stripped = String(value).replace(/\s+/g, '').trim()
  if (stripped.length === 0) return null
  const withPlus = stripped.startsWith('+') ? stripped : `+${stripped.replace(/^00/, '')}`
  const digits = withPlus.replace(/[^\d]/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  return withPlus
}

/** Split a display name into first / last on the first space. */
function splitName(full: string | null | undefined): {
  firstName: string | null
  lastName: string | null
} {
  if (!full) return { firstName: null, lastName: null }
  const trimmed = full.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return { firstName: null, lastName: null }
  const idx = trimmed.indexOf(' ')
  if (idx === -1) return { firstName: trimmed.slice(0, 120), lastName: null }
  return {
    firstName: trimmed.slice(0, idx).slice(0, 120),
    lastName: trimmed.slice(idx + 1).slice(0, 120),
  }
}

function normaliseParty(party: {
  name?: string | null
  email?: string | null
  phone?: string | null
}): NormalisedMediParty {
  const { firstName, lastName } = splitName(party.name)
  return {
    firstName,
    lastName,
    email: normaliseEmail(party.email),
    phoneE164: normalisePhoneE164(party.phone),
  }
}

/**
 * Parse + normalise a raw inbound payload. Returns null when there is nothing
 * we can key a Contact on (no account email AND no phone), so the caller can
 * 400 / no-op rather than create a ghost record.
 */
export function normaliseMediAccount(raw: unknown): NormalisedMediAccount | null {
  const parsed = mediAccountPayloadSchema.safeParse(raw)
  if (!parsed.success) return null

  const { user, contact, event } = parsed.data
  const account = normaliseParty(user)
  if (!account.email && !account.phoneE164) return null

  let related: NormalisedMediRelatedParty | null = null
  if (contact && (contact.email || contact.phone)) {
    const party = normaliseParty(contact)
    if (party.email || party.phoneE164) {
      related = { ...party, relation: contact.relation?.trim().toLowerCase() || null }
    }
  }

  return {
    event: event?.trim() || 'user.registered',
    mediUserId: String(user.id),
    role: user.role?.trim().toLowerCase() || null,
    country: user.country?.trim() || null,
    account,
    related,
  }
}
