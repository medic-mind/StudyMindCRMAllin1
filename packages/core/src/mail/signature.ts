// Pure signature selection (ADR 0021). Given a mailbox's send-as identities,
// pick the signature that belongs to a given address so the CRM composer can
// append exactly what the agent sends from Gmail. Provider-agnostic — Gmail
// populates this from users.settings.sendAs today; Outlook/IMAP can reuse it.

export interface MailSendAs {
  email: string
  signatureHtml: string | null
  isPrimary?: boolean
  isDefault?: boolean
}

/** Treat empty / whitespace-only HTML as "no signature". */
function clean(html: string | null | undefined): string | null {
  if (!html) return null
  const trimmed = html.trim()
  // A signature can be image/table-only (a logo, a rendered banner) with no
  // text at all — keep it. Only the tag-strip check below would otherwise
  // discard it as "empty".
  if (/<(img|table|picture|svg|hr)\b/i.test(trimmed)) return trimmed
  // Strip an HTML body that is visually empty (e.g. "<div><br></div>").
  const textual = trimmed.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim()
  return textual.length > 0 ? trimmed : null
}

/**
 * Choose the signature HTML for `address`. Preference order:
 *  1. the send-as entry whose email equals `address` (case-insensitive),
 *  2. the account's default send-as,
 *  3. the primary send-as,
 * returning the first that actually carries a non-empty signature, else null.
 */
export function pickSignatureForAddress(
  sendAs: readonly MailSendAs[],
  address: string,
): string | null {
  const target = address.trim().toLowerCase()
  const exact = sendAs.find((s) => s.email.trim().toLowerCase() === target)
  const byDefault = sendAs.find((s) => s.isDefault)
  const byPrimary = sendAs.find((s) => s.isPrimary)
  for (const candidate of [exact, byDefault, byPrimary]) {
    const sig = clean(candidate?.signatureHtml)
    if (sig) return sig
  }
  return null
}
