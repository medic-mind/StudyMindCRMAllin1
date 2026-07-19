// Automated Direct Debit chase decisions (ADR 0045). Pure — the hourly engine
// (worker boundary) queries state and sends; this decides. Escalation walks
// the staff-authored DdRecoveryTemplate sequence in order, so each message is
// more serious than the last; when the sequence runs out the case flags for a
// human instead of nagging forever. Nothing is ever sent without the
// staff-pasted re-signup link, and a case someone marked up to date (or that
// auto-resolved from the GoCardless mirror) never sends again.

export type ChaseChannel = 'email' | 'sms'

export interface ChaseTemplateRef {
  id: string
  channel: ChaseChannel
  subject: string | null
  body: string
}

export interface ChaseCaseState {
  status: 'new' | 'chasing' | 'escalated' | 'recovered' | 'written_off'
  autoChase: boolean
  sendEmails: boolean
  sendTexts: boolean
  chaseEmail: string | null
  chasePhoneE164: string | null
  setupLinkUrl: string | null
  escalationStep: number
  nextAutoMessageAt: Date | null
}

export type ChaseTickDecision =
  | { kind: 'skip'; reason: 'closed' | 'auto_off' | 'no_link' | 'not_due' | 'no_channel' }
  /** Every enabled channel's sequence has been fully sent — stop and flag
   *  for a human call instead of repeating the final notice forever. */
  | { kind: 'exhausted' }
  | { kind: 'send'; sends: Array<{ channel: ChaseChannel; to: string; template: ChaseTemplateRef }> }

const CLOSED = new Set(['recovered', 'written_off'])

/**
 * What (if anything) the engine should send for one case right now.
 * Templates arrive ordered most-polite → most-serious; the escalation step
 * indexes into each channel's sequence (clamped to its last entry so a
 * shorter SMS sequence keeps pace with a longer email one).
 */
export function decideChaseTick(input: {
  cs: ChaseCaseState
  now: Date
  emailTemplates: ChaseTemplateRef[]
  smsTemplates: ChaseTemplateRef[]
}): ChaseTickDecision {
  const { cs, now } = input
  if (CLOSED.has(cs.status)) return { kind: 'skip', reason: 'closed' }
  if (!cs.autoChase) return { kind: 'skip', reason: 'auto_off' }
  if (!cs.setupLinkUrl) return { kind: 'skip', reason: 'no_link' }
  if (!cs.nextAutoMessageAt || cs.nextAutoMessageAt.getTime() > now.getTime()) {
    return { kind: 'skip', reason: 'not_due' }
  }

  const channels: Array<{ channel: ChaseChannel; to: string; templates: ChaseTemplateRef[] }> = []
  if (cs.sendEmails && cs.chaseEmail && input.emailTemplates.length > 0) {
    channels.push({ channel: 'email', to: cs.chaseEmail, templates: input.emailTemplates })
  }
  if (cs.sendTexts && cs.chasePhoneE164 && input.smsTemplates.length > 0) {
    channels.push({ channel: 'sms', to: cs.chasePhoneE164, templates: input.smsTemplates })
  }
  if (channels.length === 0) return { kind: 'skip', reason: 'no_channel' }

  const longestSequence = Math.max(...channels.map((c) => c.templates.length))
  if (cs.escalationStep >= longestSequence) return { kind: 'exhausted' }

  return {
    kind: 'send',
    sends: channels.map((c) => ({
      channel: c.channel,
      to: c.to,
      template: c.templates[Math.min(cs.escalationStep, c.templates.length - 1)]!,
    })),
  }
}

/** When the next message is due after a successful send. */
export function nextChaseAt(now: Date, cadenceDays: number): Date {
  const days = Number.isFinite(cadenceDays) && cadenceDays >= 1 ? Math.floor(cadenceDays) : 3
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
}

/**
 * Has this person set their Direct Debit back up? True when the customer has
 * an ACTIVE mandate created AFTER the case was opened — the old mandate
 * surviving a cancelled plan does not count; a fresh sign-up does. (Stripe
 * re-signups can't be detected from the GC mirror — staff tick those off
 * manually.)
 */
export function chaseAutoResolved(
  caseOpenedAt: Date,
  mandates: Array<{ status: string; createdAt: Date }>,
): boolean {
  return mandates.some(
    (m) => m.status === 'active' && m.createdAt.getTime() > caseOpenedAt.getTime(),
  )
}
