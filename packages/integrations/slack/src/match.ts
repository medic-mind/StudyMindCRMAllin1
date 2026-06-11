// Contact matching for AI-parsed Slack mentions (ADR 0034). The AI extracts a
// candidate {name, email, phone} from the message; this resolves it to ONE
// contact or refuses. Strength order: email → phone (normalised variants,
// then unique 9-digit suffix) → full name. A name or number that matches
// MORE than one contact never auto-attaches (§3 never auto-merge, §12 — the
// triage tray is the human path for ambiguity).

export interface MatchCandidate {
  name?: string | null
  email?: string | null
  phone?: string | null
}

export interface MatchContactRow {
  id: string
}

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

/** E.164-ish variants for a phone as people type it in Slack ("07700 900123",
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
    if (hit.ambiguous) {
      // Same email on multiple contacts — merge candidates, a human decides.
      sawAmbiguity = true
    }
  }

  if (phone) {
    const variants = phoneVariants(phone)
    if (variants.length > 0) {
      const hit = await uniqueOrNull(db, {
        phoneE164: { in: variants },
        deletedAt: null,
      })
      if (hit.id) return { contactId: hit.id, via: 'phone', reason: 'matched' }
      if (hit.ambiguous) sawAmbiguity = true
      // Last resort: a unique national-number suffix (the last 9 digits are
      // the discriminating part of a UK number however the prefix was typed).
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

  // Names organise the bulk of Slack chatter ("Jennifer Smith wants an
  // invoice"). Auto-attach needs a full name (first + last) that matches
  // exactly ONE contact; anything looser parks for triage.
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
  }

  return { contactId: null, via: null, reason: sawAmbiguity ? 'ambiguous' : 'no_match' }
}
