// Build the rich HTML alternative for an outgoing email from the agent's
// plaintext message (ADR 0041 follow-up — HTML send). The plaintext stays the
// authoritative `text/plain` part; this renders the `text/html` part so the
// message looks like Gmail and the copied HTML signature shows with its real
// formatting. Pure + unit-tested.

const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE[c] ?? c)
}

/** Linkify bare http/https URLs. Runs AFTER escaping, so the matched text is
 *  already HTML-safe and the href cannot break out of the attribute. */
function autolink(escaped: string): string {
  return escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" style="color:#2563eb">${url}</a>`,
  )
}

/**
 * Render a plaintext message as safe HTML: each blank-line-separated block
 * becomes a `<p>`, single newlines become `<br>`, URLs are linkified, and all
 * other content is HTML-escaped (no injection from the typed body).
 */
export function plaintextToHtml(text: string): string {
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = normalised.split(/\n{2,}/)
  return blocks
    .map((block) => {
      const inner = autolink(escapeHtml(block)).replace(/\n/g, '<br>')
      return `<p style="margin:0 0 12px;white-space:pre-wrap">${inner}</p>`
    })
    .join('')
}

export interface OutgoingEmailBodies {
  /** Authoritative text/plain part. */
  text: string
  /** Rich text/html part. */
  html: string
}

/**
 * Assemble the two MIME alternatives for an outgoing email: the agent's
 * plaintext `body` plus the account signature (its HTML form appended to the
 * html part, its plaintext form to the text part). `signatureText` is supplied
 * by the caller (it already owns an HTML→text converter); keeping it injected
 * lets this stay pure.
 */
export function buildOutgoingEmail(input: {
  body: string
  signatureHtml?: string | null
  signatureText?: string | null
  /** Quoted original (reply) or forwarded block, appended AFTER the signature
   *  exactly like Gmail. Already-built text + html forms (see `quote.ts`). */
  quotedText?: string | null
  quotedHtml?: string | null
}): OutgoingEmailBodies {
  const sigHtml = input.signatureHtml?.trim() || ''
  const sigText = input.signatureText?.trim() || ''
  let text = sigText ? `${input.body}\n\n${sigText}` : input.body
  let html = sigHtml
    ? `${plaintextToHtml(input.body)}<br>${sigHtml}`
    : plaintextToHtml(input.body)
  if (input.quotedText && input.quotedText.trim().length > 0) {
    text = `${text}\n\n${input.quotedText}`
  }
  if (input.quotedHtml && input.quotedHtml.trim().length > 0) {
    html = `${html}<br>${input.quotedHtml}`
  }
  return { text, html }
}
