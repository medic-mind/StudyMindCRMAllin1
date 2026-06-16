// Canonical "which existing contact does this refer to?" matcher. One place,
// reused by Slack mention archival (ADR 0034), the new Call Summaries entry
// point (an agent typing who they spoke to), and any future candidate
// resolver. Deterministic and FREE — no AI spend.
//
// Strength order: email → phone (E.164-normalised variants, then unique
// 9-digit national suffix) → name. The name pass matches an unambiguous
// first+last, AND an unambiguous single token / surname / whole-name-in-one-
// column (so "spoke to Aanya" resolves). A candidate that matches MORE than one
// contact never resolves (§3 never auto-merge, §41.1 — the caller surfaces the
// candidates for a human to pick).

export interface MatchCandidate {
  /** Full name (first + last) the message/agent referenced. */
  name?: string | null
  email?: string | null
  /** As-typed; not necessarily E.164 — phoneVariants normalises it. */
  phone?: string | null
}

export interface MatchContactRow {
  id: string
}

/** Minimal db port — just the contact lookups the matcher needs, so callers
 *  can pass a Prisma client (or a fake in tests). */
export interface MatchDb {
  contact: {
    findMany(args: {
      where: Record<string, unknown>
      select: { id: true }
      take: number
    }): Promise<MatchContactRow[]>
  }
}

export type MatchVia = 'email' | 'phone' | 'name'

export interface MatchOutcome {
  contactId: string | null
  via: MatchVia | null
  /** Why no contact was attached (for the tray + logs). */
  reason: 'matched' | 'no_candidate' | 'no_match' | 'ambiguous'
}

/** E.164-ish variants for a phone as people type it ("07700 900123",
 *  "+44 7700 900123", "447700900123"). */
export function phoneVariants(raw: string): string[] {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/[^\d]/gu, '')
  const out = new Set<string>()
  if (trimmed.startsWith('+') && digits.length >= 7) out.add(`+${digits}`)
  if (digits.startsWith('00') && digits.length >= 12) out.add(`+${digits.slice(2)}`)
  // UK national: 07700 900123 → +447700900123
  if (digits.startsWith('0') && (digits.length === 10 || digits.length === 11)) {
    out.add(`+44${digits.slice(1)}`)
  }
  // Dial code typed without the +: 447700900123
  if (!digits.startsWith('0') && digits.length >= 11 && digits.length <= 15) {
    out.add(`+${digits}`)
  }
  // Legacy as-typed rows (pre phone-repair) stored bare digits.
  if (digits.length >= 7) out.add(digits)
  return [...out]
}

const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+\.[a-z]{2,}/giu
const PHONE_IN_TEXT = /(?:\+|00)?[\d][\d\s().-]{7,}\d/gu

/** Pull an email and/or phone out of free text (a call-summary body), so an
 *  agent who typed "spoke to Jane on 07700 900123" still de-dupes against the
 *  existing contact. Returns the FIRST of each — best-effort, deterministic. */
export function extractIdentifiersFromText(text: string): {
  email: string | null
  phone: string | null
} {
  const email = text.match(EMAIL_IN_TEXT)?.[0]?.toLowerCase() ?? null
  // Guard against matching a long id/date: require a plausible phone length.
  let phone: string | null = null
  for (const m of text.matchAll(PHONE_IN_TEXT)) {
    const digits = m[0].replace(/[^\d]/gu, '')
    if (digits.length >= 9 && digits.length <= 15) {
      phone = m[0].trim()
      break
    }
  }
  return { email, phone }
}

async function uniqueOrNull(
  db: MatchDb,
  where: Record<string, unknown>,
): Promise<{ id: string | null; ambiguous: boolean }> {
  const rows = await db.contact.findMany({ where, select: { id: true }, take: 2 })
  if (rows.length === 1) return { id: rows[0]!.id, ambiguous: false }
  return { id: null, ambiguous: rows.length > 1 }
}

export async function matchContactByCandidate(
  db: MatchDb,
  candidate: MatchCandidate,
): Promise<MatchOutcome> {
  const email = candidate.email?.trim().toLowerCase() ?? null
  const phone = candidate.phone?.trim() ?? null
  const name = candidate.name?.trim().replace(/\s+/gu, ' ') ?? null

  if (!email && !phone && !name) {
    return { contactId: null, via: null, reason: 'no_candidate' }
  }
  let sawAmbiguity = false

  if (email) {
    const hit = await uniqueOrNull(db, {
      email: { equals: email, mode: 'insensitive' },
      deletedAt: null,
    })
    if (hit.id) return { contactId: hit.id, via: 'email', reason: 'matched' }
    if (hit.ambiguous) sawAmbiguity = true
  }

  if (phone) {
    const variants = phoneVariants(phone)
    if (variants.length > 0) {
      const hit = await uniqueOrNull(db, { phoneE164: { in: variants }, deletedAt: null })
      if (hit.id) return { contactId: hit.id, via: 'phone', reason: 'matched' }
      if (hit.ambiguous) sawAmbiguity = true
      const digits = phone.replace(/[^\d]/gu, '')
      if (!hit.ambiguous && digits.length >= 9) {
        const suffix = await uniqueOrNull(db, {
          phoneE164: { endsWith: digits.slice(-9) },
          deletedAt: null,
        })
        if (suffix.id) return { contactId: suffix.id, via: 'phone', reason: 'matched' }
        if (suffix.ambiguous) sawAmbiguity = true
      }
    }
  }

  if (name) {
    const tokens = name.split(' ')
    if (tokens.length >= 2) {
      const firstName = tokens[0]!
      const lastName = tokens.slice(1).join(' ')
      const hit = await uniqueOrNull(db, {
        deletedAt: null,
        firstName: { equals: firstName, mode: 'insensitive' },
        lastName: { equals: lastName, mode: 'insensitive' },
      })
      if (hit.id) return { contactId: hit.id, via: 'name', reason: 'matched' }
      if (hit.ambiguous) sawAmbiguity = true
    }
    // Single-token ("spoke to Aanya"), a unique surname ("the Patels"), or a
    // full name stored in ONE column — auto-link only when EXACTLY one contact
    // carries it as a first OR last name (unambiguous; §3 never guess between
    // two same-named people, the caller's tray takes the ambiguous ones). This
    // is what lets the common first-name-only Slack mention resolve at all.
    const single = await uniqueOrNull(db, {
      deletedAt: null,
      OR: [
        { firstName: { equals: name, mode: 'insensitive' } },
        { lastName: { equals: name, mode: 'insensitive' } },
      ],
    })
    if (single.id) return { contactId: single.id, via: 'name', reason: 'matched' }
    if (single.ambiguous) sawAmbiguity = true
  }

  return { contactId: null, via: null, reason: sawAmbiguity ? 'ambiguous' : 'no_match' }
}
