// Deterministic contact-signal extraction from Slack message text — runs
// BEFORE any AI spend (cheapest route first; AI is the last resort). The
// team's call-log format ("🇬🇧Leisha Burgess +447359988992 Medic Mind …")
// carries a phone/email verbatim, so most mentions match with zero AI —
// and keep working when the AI provider is down or over budget.

/** Unwrap Slack mrkdwn entities to readable text: `<tel:x|y>`/`<mailto:x|y>`
 *  → label, `<url|label>` → label, `<url>` → url, mentions stripped. */
export function slackTextToPlain(text: string): string {
  return text
    .replace(/<(?:tel|mailto):([^>|]+)\|([^>]+)>/giu, '$2')
    .replace(/<(?:tel|mailto):([^>|]+)>/giu, '$1')
    .replace(/<https?:[^>|]+\|([^>]+)>/giu, '$1')
    .replace(/<(https?:[^>|]+)>/giu, '$1')
    .replace(/<[@!][^>]+>/gu, ' ')
    .replace(/<#[^>|]+\|([^>]+)>/gu, '#$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim()
}

export interface ContactSignals {
  email: string | null
  phone: string | null
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/iu
/** A phone-shaped run: optional +, then 9+ digits allowing spaces/()-. */
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/u

/**
 * Pull the first email and/or phone out of a Slack message. Slack often
 * auto-links them (`<tel:+447…|+447…>`, `<mailto:a@b|a@b>`), so the markup
 * forms are read first, then the plain text. A phone needs ≥ 9 digits —
 * shorter runs are order numbers / prices, not diallable numbers.
 */
export function extractContactSignals(text: string): ContactSignals {
  const telMarkup = /<tel:([^>|]+)(?:\|[^>]*)?>/iu.exec(text)?.[1] ?? null
  const mailtoMarkup = /<mailto:([^>|]+)(?:\|[^>]*)?>/iu.exec(text)?.[1] ?? null
  const plain = slackTextToPlain(text)

  const email = mailtoMarkup ?? EMAIL_RE.exec(plain)?.[0] ?? null

  let phone: string | null = null
  const phoneRaw = telMarkup ?? PHONE_RE.exec(plain)?.[0] ?? null
  if (phoneRaw) {
    const digits = phoneRaw.replace(/[^\d+]/gu, '')
    const digitCount = digits.replace(/\D/gu, '').length
    if (digitCount >= 9 && digitCount <= 15) phone = digits
  }

  return { email: email?.trim().toLowerCase() ?? null, phone }
}
