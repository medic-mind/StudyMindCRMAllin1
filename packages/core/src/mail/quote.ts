// Reply / reply-all / forward helpers — recipient computation, Re:/Fwd: subject
// prefixing, and the quoted-original block (text + HTML), matching Gmail's
// behaviour. Pure + unit-tested; the router supplies the original message's
// addresses/body and renders the result through `buildOutgoingEmail`.

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

/** Lower-case + de-duplicate a list of plain email addresses, preserving order. */
function uniqueLower(addrs: ReadonlyArray<string>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const a of addrs) {
    const v = a.trim().toLowerCase()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

export interface ReplyAllInput {
  /** Sender(s) of the message being replied to. */
  from: ReadonlyArray<string>
  /** Original To recipients. */
  to: ReadonlyArray<string>
  /** Original Cc recipients. */
  cc: ReadonlyArray<string>
  /** Our own addresses (mailbox + aliases) to exclude from the reply. */
  self: ReadonlyArray<string>
}

/**
 * Gmail "Reply all": To = the original sender; Cc = everyone else on the
 * original To+Cc, minus ourselves and minus the sender (who is now in To).
 * Addresses are assumed already plain (no display names) — the sync stores them
 * that way — and are lower-cased + de-duplicated.
 */
export function computeReplyAllRecipients(input: ReplyAllInput): {
  to: string[]
  cc: string[]
} {
  const self = new Set(uniqueLower(input.self))
  const from = uniqueLower(input.from).filter((a) => !self.has(a))
  const to = from.length > 0 ? [from[0]!] : []
  const sender = new Set(from)
  const cc = uniqueLower([...input.to, ...input.cc]).filter(
    (a) => !self.has(a) && !sender.has(a),
  )
  return { to, cc }
}

/** Reply To = the original sender, minus ourselves. */
export function computeReplyRecipients(input: {
  from: ReadonlyArray<string>
  self: ReadonlyArray<string>
}): { to: string[] } {
  const self = new Set(uniqueLower(input.self))
  const from = uniqueLower(input.from).filter((a) => !self.has(a))
  return { to: from.length > 0 ? [from[0]!] : uniqueLower(input.from).slice(0, 1) }
}

function stripPrefix(subject: string, re: RegExp): string {
  return subject.replace(re, '').trim()
}

/** "Re: …" once (never "Re: Re: …"). */
export function replySubject(subject: string | null | undefined): string {
  const s = (subject ?? '').trim()
  if (/^re:/i.test(s)) return s
  return `Re: ${stripPrefix(s, /^(fwd?:)\s*/i)}`.trim()
}

/** "Fwd: …" once. */
export function forwardSubject(subject: string | null | undefined): string {
  const s = (subject ?? '').trim()
  if (/^fwd?:/i.test(s)) return s
  return `Fwd: ${stripPrefix(s, /^(re:)\s*/i)}`.trim()
}

function formatWhen(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  }).format(date)
}

function sender(fromName: string | null, fromEmail: string | null): string {
  if (fromName && fromEmail) return `${fromName} <${fromEmail}>`
  return fromName ?? fromEmail ?? 'unknown sender'
}

export interface QuoteOriginal {
  date: Date | null
  fromName: string | null
  fromEmail: string | null
  /** Plain-text body of the original (authoritative for the text part). */
  text: string | null
  /** Sanitised HTML body of the original, if any. */
  html: string | null
}

/** Prefix each line with "> " for the plain-text quote. */
function quoteText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
}

/**
 * The quoted-original block for a reply / reply-all: an attribution line
 * ("On <date>, <sender> wrote:") followed by the original, quoted. Returns both
 * the text/plain and text/html forms to append after the body+signature.
 */
export function buildReplyQuote(o: QuoteOriginal): { text: string; html: string } {
  const when = formatWhen(o.date)
  const who = sender(o.fromName, o.fromEmail)
  const attribution = when ? `On ${when}, ${who} wrote:` : `${who} wrote:`
  const originalText = o.text ?? ''
  const text = `${attribution}\n${quoteText(originalText)}`
  const innerHtml = o.html && o.html.trim().length > 0
    ? o.html
    : `<div style="white-space:pre-wrap">${escapeHtml(originalText)}</div>`
  const html =
    `<div class="gmail_quote">` +
    `<div style="color:#5f6368;font-size:12px">${escapeHtml(attribution)}</div>` +
    `<blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #dadce0;padding-left:1ex;color:#202124">` +
    `${innerHtml}</blockquote></div>`
  return { text, html }
}

export interface ForwardOriginal extends QuoteOriginal {
  to: ReadonlyArray<string>
  cc: ReadonlyArray<string>
  subject: string | null
}

/**
 * The "---------- Forwarded message ----------" block Gmail inserts, with the
 * original From / Date / Subject / To / Cc header lines and the original body.
 */
export function buildForwardQuote(o: ForwardOriginal): { text: string; html: string } {
  const when = formatWhen(o.date)
  const who = sender(o.fromName, o.fromEmail)
  const to = uniqueLower(o.to)
  const cc = uniqueLower(o.cc)
  const headerLinesText = [
    'From: ' + who,
    when ? `Date: ${when}` : null,
    `Subject: ${o.subject ?? ''}`,
    to.length > 0 ? `To: ${to.join(', ')}` : null,
    cc.length > 0 ? `Cc: ${cc.join(', ')}` : null,
  ].filter((x): x is string => !!x)

  const originalText = o.text ?? ''
  const text =
    `---------- Forwarded message ----------\n` +
    `${headerLinesText.join('\n')}\n\n` +
    originalText

  const headerLinesHtml = headerLinesText.map((l) => escapeHtml(l)).join('<br>')
  const innerHtml = o.html && o.html.trim().length > 0
    ? o.html
    : `<div style="white-space:pre-wrap">${escapeHtml(originalText)}</div>`
  const html =
    `<div class="gmail_quote">` +
    `<div style="color:#5f6368;font-size:12px">---------- Forwarded message ----------<br>${headerLinesHtml}</div>` +
    `<br>${innerHtml}</div>`
  return { text, html }
}
