// Pure parser for Google Voice notification emails (Option A — ADR 0032).
//
// Google Voice has no public call/SMS API, so we ingest the notification
// emails it sends to the connected mailbox (voicemails with transcript +
// audio, missed calls, inbound texts) through the existing Gmail sync. This
// module is pure (no I/O) so the brittle bit — recognising and dissecting the
// email — is fully unit-tested; the side-effecting handler lives in jobs.ts.
//
// Formats vary, so parsing is best-effort and fails soft: an unrecognised
// Google Voice email still yields `{ kind: 'unknown' }` and the handler logs
// it for a human to triage rather than dropping it.

/** Google Voice always sends from this address. */
export const GOOGLE_VOICE_SENDER = 'voice-noreply@google.com'

export type GoogleVoiceKind = 'voicemail' | 'missed_call' | 'text' | 'unknown'

export interface GoogleVoiceNotification {
  kind: GoogleVoiceKind
  /** Caller / sender display name, when Google Voice knew it. */
  counterpartyName: string | null
  /** The number exactly as it appeared (e.g. "(555) 123-4567"). */
  phoneRaw: string | null
  /** Best-effort E.164 (e.g. "+15551234567"); null when we can't be sure. */
  phoneE164: string | null
  /** Voicemail transcript or text-message body; null for a bare missed call. */
  content: string | null
}

/** True when any of the parsed From addresses is the Google Voice notifier. */
export function isGoogleVoiceSender(fromAddrs: readonly string[]): boolean {
  return fromAddrs.some((a) => a.trim().toLowerCase() === GOOGLE_VOICE_SENDER)
}

/** A phone-like run of digits and separators. */
const PHONE_RE = /(\+?\d[\d\s().-]{5,}\d)/

/**
 * Best-effort E.164 normalisation. Google Voice numbers are NANP (US/Canada)
 * unless the counterparty's own number carries a country code (then it is
 * shown with a leading "+"). We only return a value we are confident about —
 * otherwise null, so the call is logged with the raw number and flagged for a
 * human (this channel needs manual work by design).
 */
export function normaliseToE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.startsWith('+')) {
    const compact = '+' + trimmed.slice(1).replace(/\D/g, '')
    return compact.length >= 8 ? compact : null
  }
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  return null
}

function kindFromSubject(subject: string): GoogleVoiceKind {
  const s = subject.toLowerCase()
  if (s.includes('voicemail')) return 'voicemail'
  if (s.includes('missed call')) return 'missed_call'
  if (s.includes('text message') || s.includes('sms')) return 'text'
  return 'unknown'
}

/** Pull the "<name and/or number>" that follows "from " in the subject. */
function fromClause(subject: string): string | null {
  const m = /from\s+(.+?)(?:\s+at\s+\d.*)?$/i.exec(subject.trim())
  return m?.[1]?.trim() ?? null
}

function splitNameAndPhone(clause: string): { name: string | null; phoneRaw: string | null } {
  const m = PHONE_RE.exec(clause)
  if (!m) {
    const name = clause.trim()
    return { name: name.length > 0 ? name : null, phoneRaw: null }
  }
  const phoneRaw = m[1]!.trim()
  const name = clause.replace(m[1]!, '').replace(/[()\-,]/g, ' ').trim()
  return { name: name.length > 0 ? name : null, phoneRaw }
}

export interface ParseGoogleVoiceInput {
  subject: string
  /** Plain-text body of the email (transcript / message content lives here). */
  bodyText: string
}

export function parseGoogleVoiceNotification(
  input: ParseGoogleVoiceInput,
): GoogleVoiceNotification {
  const kind = kindFromSubject(input.subject)
  const clause = fromClause(input.subject) ?? ''
  const { name, phoneRaw: subjectPhone } = splitNameAndPhone(clause)

  // Fall back to the first phone-like token in the body when the subject only
  // carried a name.
  let phoneRaw = subjectPhone
  if (!phoneRaw) {
    const m = PHONE_RE.exec(input.bodyText)
    phoneRaw = m?.[1]?.trim() ?? null
  }

  const content =
    kind === 'missed_call' ? null : input.bodyText.trim().length > 0 ? input.bodyText.trim() : null

  return {
    kind,
    counterpartyName: name,
    phoneRaw,
    phoneE164: normaliseToE164(phoneRaw),
    content,
  }
}
