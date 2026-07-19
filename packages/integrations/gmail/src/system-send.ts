// System / transactional email via Gmail (Google OAuth). CLAUDE.md §14.
//
// We do NOT use a third-party email API. All staff-facing system email
// (account welcome, admin password reset, self-service forgot/verify,
// "forward to team") is sent through a connected Gmail mailbox using the
// per-account OAuth token (ADR 0012) — the same mechanism as agent replies,
// but composing a fresh RFC 5322 message instead of threading a reply.
//
// The "system mailbox" is resolved from SYSTEM_GMAIL_EMAIL (default
// info@studymind.co.uk): the User row with that email must have connected
// Gmail. If no system mailbox is connected we fall back to any connected
// default mailbox, and if none exists at all the send is `skipped` (callers
// tolerate that — e.g. the admin still sees the temporary password in the UI).

import { createId } from '@paralleldrive/cuid2'

import { db } from '@studymind/db'

import { createClientForAgent } from './client'

const CRLF = '\r\n'
const DEFAULT_SYSTEM_EMAIL = 'info@studymind.co.uk'

export interface SystemEmailAttachment {
  filename: string
  /** Raw bytes — base64 encoding happens inside buildRawEmail. */
  content: Buffer
  contentType?: string
}

export interface SendSystemEmailInput {
  to: string | string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  /** Plaintext body — always set so every message has a text/plain part. */
  text: string
  /** Optional HTML body (sent as a multipart/alternative alongside text). */
  html?: string
  attachments?: SystemEmailAttachment[]
  /** Override the sending mailbox (defaults to the configured system mailbox). */
  fromAgentId?: string
  /** Send AS this specific connected mailbox address (e.g. info@studymind.co.uk).
   *  Uses that mailbox's own OAuth token; falls back to the agent's default
   *  mailbox if the address isn't connected. Null/undefined = system default. */
  fromAddress?: string
  /** OpenTelemetry trace id for the decrypt audit; defaults to a fresh id. */
  requestId?: string
}

export interface SystemEmailResult {
  status: 'sent' | 'skipped' | 'failed'
  /** Gmail message id when sent. */
  id: string | null
  detail?: string
}

/* -------------------------------------------------------------------------- */
/* MIME builder                                                                */
/* -------------------------------------------------------------------------- */

function base76(data: Buffer): string {
  const b = data.toString('base64')
  const lines: string[] = []
  for (let i = 0; i < b.length; i += 76) lines.push(b.slice(i, i + 76))
  return lines.join(CRLF)
}

function b64Text(value: string): string {
  return base76(Buffer.from(value, 'utf8'))
}

function boundary(seed: string): string {
  return `==SMCRM_${seed.replace(/[^a-z0-9]/gi, '').slice(0, 28)}==`
}

function headerSafe(value: string): string {
  return value.replace(/[\r\n]/g, ' ')
}

function quotedFilename(name: string): string {
  return name.replace(/[\r\n"]/g, '_')
}

function textPartEntity(text: string): string {
  return (
    `Content-Type: text/plain; charset="UTF-8"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    `${b64Text(text)}${CRLF}`
  )
}

function alternativeEntity(text: string, html: string, seed: string): string {
  const bnd = boundary(`alt${seed}`)
  const nested =
    `--${bnd}${CRLF}${textPartEntity(text)}` +
    `--${bnd}${CRLF}Content-Type: text/html; charset="UTF-8"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}${b64Text(html)}${CRLF}` +
    `--${bnd}--${CRLF}`
  return `Content-Type: multipart/alternative; boundary="${bnd}"${CRLF}${CRLF}${nested}`
}

function attachmentPartEntity(att: SystemEmailAttachment): string {
  const name = quotedFilename(att.filename)
  const ct = att.contentType ?? 'application/octet-stream'
  return (
    `Content-Type: ${ct}; name="${name}"${CRLF}` +
    `Content-Disposition: attachment; filename="${name}"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    `${base76(att.content)}${CRLF}`
  )
}

export interface BuildRawEmailInput {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  html?: string
  attachments?: SystemEmailAttachment[]
  from?: string
  boundarySeed?: string
}

/**
 * Build a fresh RFC 5322 message and base64url-encode it for the Gmail SDK
 * `users.messages.send` call. Exported for unit testing.
 */
export function buildRawEmail(input: BuildRawEmailInput): string {
  const seed = input.boundarySeed ?? createId()
  const hasAttachments = (input.attachments?.length ?? 0) > 0
  const hasHtml = Boolean(input.html)

  const headers: Record<string, string> = {
    'MIME-Version': '1.0',
    To: input.to.map(headerSafe).join(', '),
    Subject: headerSafe(input.subject),
  }
  if (input.from) headers['From'] = headerSafe(input.from)
  if (input.cc && input.cc.length > 0) headers['Cc'] = input.cc.map(headerSafe).join(', ')
  if (input.bcc && input.bcc.length > 0) headers['Bcc'] = input.bcc.map(headerSafe).join(', ')

  let body: string
  if (hasAttachments) {
    const bnd = boundary(`mix${seed}`)
    headers['Content-Type'] = `multipart/mixed; boundary="${bnd}"`
    const inner = hasHtml
      ? alternativeEntity(input.text, input.html as string, seed)
      : textPartEntity(input.text)
    let parts = `--${bnd}${CRLF}${inner}`
    for (const att of input.attachments as SystemEmailAttachment[]) {
      parts += `--${bnd}${CRLF}${attachmentPartEntity(att)}`
    }
    parts += `--${bnd}--${CRLF}`
    body = parts
  } else if (hasHtml) {
    const bnd = boundary(`alt${seed}`)
    headers['Content-Type'] = `multipart/alternative; boundary="${bnd}"`
    body =
      `--${bnd}${CRLF}${textPartEntity(input.text)}` +
      `--${bnd}${CRLF}Content-Type: text/html; charset="UTF-8"${CRLF}` +
      `Content-Transfer-Encoding: base64${CRLF}${CRLF}${b64Text(input.html as string)}${CRLF}` +
      `--${bnd}--${CRLF}`
  } else {
    headers['Content-Type'] = 'text/plain; charset="UTF-8"'
    headers['Content-Transfer-Encoding'] = 'base64'
    body = b64Text(input.text)
  }

  const headerLines = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join(CRLF)
  const message = `${headerLines}${CRLF}${CRLF}${body}`
  return Buffer.from(message, 'utf8').toString('base64url')
}

/* -------------------------------------------------------------------------- */
/* mailbox resolution + send                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the agent (User) whose connected Gmail mailbox should send system
 * email: the SYSTEM_GMAIL_EMAIL account if it has connected Gmail, else any
 * connected default mailbox, else null.
 */
export async function resolveSystemAgentId(): Promise<string | null> {
  const configured = (process.env['SYSTEM_GMAIL_EMAIL'] ?? DEFAULT_SYSTEM_EMAIL)
    .trim()
    .toLowerCase()
  if (configured) {
    const user = await db.user.findUnique({
      where: { email: configured },
      select: { id: true, gmailRefreshTokenCipherId: true },
    })
    if (user?.gmailRefreshTokenCipherId) return user.id
  }
  // Fallback: any connected mailbox (prefer a default one).
  const mailbox = await db.gmailMailbox.findFirst({
    where: { deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { agentId: true },
  })
  return mailbox?.agentId ?? null
}

/**
 * Send a fresh system email through a connected Gmail mailbox. Never throws —
 * returns `skipped` when no mailbox is connected (so account creation and
 * password reset still succeed and surface the temporary password in the UI),
 * and `failed` on a transport error.
 */
export async function sendSystemEmail(input: SendSystemEmailInput): Promise<SystemEmailResult> {
  const to = (Array.isArray(input.to) ? input.to : [input.to])
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (to.length === 0) return { status: 'skipped', id: null, detail: 'No recipients' }

  const agentId = input.fromAgentId ?? (await resolveSystemAgentId())
  if (!agentId) {
    return {
      status: 'skipped',
      id: null,
      detail: 'No system Gmail mailbox connected (set SYSTEM_GMAIL_EMAIL and connect Gmail).',
    }
  }

  const requestId = input.requestId ?? createId()
  try {
    const client = await createClientForAgent({
      agentId,
      ...(input.fromAddress ? { address: input.fromAddress } : {}),
      purpose: 'gmail.system_send',
      requestId,
    })
    const raw = buildRawEmail({
      to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
    })
    const res = await client.sendMessage({ raw })
    return { status: 'sent', id: res.id || null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Missing/revoked token → not connected yet; treat as skipped so the
    // surrounding flow continues.
    if (/no gmail token/i.test(msg) || /invalid_grant/i.test(msg)) {
      return { status: 'skipped', id: null, detail: 'System mailbox not connected' }
    }
    return { status: 'failed', id: null, detail: msg }
  }
}
